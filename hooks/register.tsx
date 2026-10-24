import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, SessionMessage } from 'claude-code'

import type { DxMcp, McpOrg, OrgInfo, OrgType, PrInfo, PrRef } from '../types'
import { CONTEXT_LABEL, MARKER_LABEL, ORG_LABEL, accountEmail, contextColor, contextPercent, looksFrom, nameColor, orgLabel, otherLogin, repeatsAlias } from './additions'
import { resolveMcp } from './mcp'
import { resolveOrg, toOrgInfo } from './org'
import { PR_FIELDS, failingText, lastSessionPr, prOf, prRefOf } from './pr'
import { ORG_TYPE_COLOR, ORG_TYPE_LABEL, RISK, WATCH_MS, connectedServers, domainFits, domainName, myDomainOf, resolveSfOrg, sfDefaults, splitTool, watchedPaths, wireName } from './salesforce'
import type { ReadFile, SfDomain, SfEnv } from './salesforce'
import { isHookRefusal, lastSfCommand, sfTargets } from './targets'

const org = atom({ plugin: 'sf-headless-band', key: 'org' } as const, null)
const mcp = atom({ plugin: 'sf-headless-band', key: 'mcp' } as const, [] as McpOrg[])
const dx = atom({ plugin: 'sf-headless-band', key: 'dx' } as const, [] as DxMcp[])
const hidden = atom({ plugin: 'sf-headless-band', key: 'hidden' } as const, true)
const domains = atom({ plugin: 'sf-headless-band', key: 'domains' } as const, {} as Record<string, SfDomain>)
const context = atom({ plugin: 'sf-headless-band', key: 'context' } as const, null as number | null)
const pr = atom({ plugin: 'sf-headless-band', key: 'pr' } as const, null as PrInfo | null)
const SESSION_PR = { plugin: 'sf-headless-band', key: 'sessionPr' } as const
const sessionPr = atom(SESSION_PR, null as PrRef | null)
const LAST_SF = { plugin: 'sf-headless-band', key: 'lastSf' } as const
const lastSf = atom(LAST_SF, [] as OrgInfo[])

// The person's own shared sandboxes, review gates and sf wrappers, from the userConfig options at each load
let looks = looksFrom({})

/** Reads a file's text through the engine, or undefined when it is missing or unreadable. */
const fileReader =
  ($: EngineInterface): ReadFile =>
  (path: string) =>
    $.fs.read(path).then(
      text => (typeof text === 'string' ? text : undefined),
      () => undefined,
    )

/**
 * Keeps the orgs a shell command named for the Salesforce CLI, each resolved through the
 * CLI's aliases and auth files; a command that reaches no org through sf leaves them standing.
 */
async function noteSf($: EngineInterface, command: unknown) {
  const targets = typeof command === 'string' ? sfTargets(command, looks.sfWrappers) : undefined
  if (targets === undefined) return
  const home = (await $.env.get('HOME')) ?? ''
  const readFile = fileReader($)
  const defaults = await sfDefaults(readFile, await $.session.cwd(), home)
  const now = await $.clock.now()
  const orgs: OrgInfo[] = []
  for (const target of targets) {
    const info = toOrgInfo(await resolveSfOrg(readFile, home, defaults, target, now))
    if (info !== undefined && !orgs.some(o => o.username === info.username)) orgs.push(info)
  }
  orgs.sort((a, b) => RISK.indexOf(a.type) - RISK.indexOf(b.type))
  if (!same(await read($, lastSf), orgs)) await update($, lastSf, () => orgs)
}

/** The transcript, read on the first call and shared by the calls after it. */
type Transcript = () => Promise<readonly SessionMessage[]>

const transcriptOnce = ($: EngineInterface): Transcript => {
  let messages: Promise<readonly SessionMessage[]> | undefined
  return () => (messages ??= $.session.messages())
}

/**
 * Reads the last sf command back from the transcript when the session's state holds no answer:
 * a resume, /clear or a fork starts that state empty, while the transcript still has the command.
 */
async function restoreSf($: EngineInterface, transcript: Transcript) {
  const isUnset = async () => (await $.state.get(LAST_SF)).value === undefined
  if (!(await isUnset())) return
  const command = lastSfCommand(await transcript(), looks.sfWrappers)
  // A command that ended during the read has already said where it went
  if (!(await isUnset())) return
  if (command !== undefined) await noteSf($, command)
  // Written even when empty, so the transcript is read once per reset and not on every refresh
  if (await isUnset()) await update($, lastSf, () => [])
}

/**
 * Reads the session's own pull request back from the transcript when the session's state holds
 * no answer, as restoreSf does for the last sf command.
 */
async function restoreSessionPr($: EngineInterface, transcript: Transcript) {
  const isUnset = async () => (await $.state.get(SESSION_PR)).value === undefined
  if (!(await isUnset())) return
  const found = lastSessionPr(await transcript())
  // A command that ended during the read has already named its pull request
  if (await isUnset()) await update($, sessionPr, () => found ?? null)
}

/** Keeps the context figure the band shows. */
async function setContext($: EngineInterface, percent: number | null) {
  if ((await read($, context)) !== percent) await update($, context, () => percent)
}

// How often an open pull request is read again, and how long any answer stands before a turn's
// end reads it again: GitHub is asked at most this often per session, never on the 15 s tick
const PR_MS = 120_000

// The folder, branch and session pull request last read for and when, the read running, whether
// a forced read waits behind it, and the timer reading an open one again
let prFor: string | undefined
let prAt = 0
let prReading: Promise<void> | undefined
let prAgain = false
let prTicker: { cancel: () => void } | undefined

/** A command's output, run in the session's folder; undefined when it can't start, fails or runs too long. */
async function output($: EngineInterface, argv: string[], timeoutMs: number): Promise<string | undefined> {
  try {
    const ran = await $.process.run(argv, { timeoutMs })
    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads the pull request with `gh`, the session folder's branch's first and else the session's
 * own: at once when `force`, else only when the folder, branch or session pull request changed
 * or the last answer is older than PR_MS.
 */
function refreshPr($: EngineInterface, force = false): Promise<void> {
  if (prReading) {
    if (force) prAgain = true
    return prReading
  }
  prReading = (async () => {
    try {
      await readPr($, force)
    } catch {
      // A failed read leaves the last answer standing
    } finally {
      prReading = undefined
    }
    if (prAgain) {
      prAgain = false
      await refreshPr($, true)
    }
  })()
  return prReading
}

/**
 * Reads the pull request from a timer of its own: a `$` call still running once a hook has
 * returned is cut off with that hook's dispatch, so a read started there and left running
 * would never land, and awaiting it there would hold the event up on GitHub.
 */
function soon($: EngineInterface, force = false) {
  $.clock.after(0, () => void refreshPr($, force))
}

async function readPr($: EngineInterface, force: boolean) {
  if (await read($, hidden)) return
  const head = (await output($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], 5_000))?.trim()
  // Not a repository, or no branch checked out
  const branch = head && head !== 'HEAD' ? head : undefined
  // A session working on a branch from another folder, such as a worktree it drives from the
  // root checkout, still has the pull request its own commands created or acted on
  const own = await read($, sessionPr)
  if (branch === undefined && own === null) {
    prFor = undefined
    return setPr($, null)
  }
  const key = `${await $.session.cwd()}|${branch ?? ''}|${own?.url ?? own?.number ?? ''}`
  const now = await $.clock.now()
  if (!force && key === prFor && now - prAt < PR_MS) return
  prFor = key
  prAt = now
  // No pull request for the branch, gh missing or signed out, or not a GitHub remote: the session's own, else no line
  const forBranch = branch === undefined ? undefined : await output($, ['gh', 'pr', 'view', '--json', PR_FIELDS], 20_000)
  const text = forBranch ?? (own === null ? undefined : await output($, ['gh', 'pr', 'view', own.url ?? String(own.number), '--json', PR_FIELDS], 20_000))
  await setPr($, text === undefined ? null : prOf(text, looks.gates))
}

async function setPr($: EngineInterface, next: PrInfo | null) {
  if (!same(await read($, pr), next)) await update($, pr, () => next)
}

// Whether the band is switched off, kept across sessions; off until /sf-headless-band turns it on
const HIDDEN = 'hidden'
// The My Domains hosted servers' calls carried, as sf-headless-config keeps them
const DOMAINS = 'domains'

const REFRESH_MS = 15_000

// The watched files' times and sizes at the last read, and the timers refreshing the band
let stamp: string | undefined
let ticker: { cancel: () => void } | undefined
let watcher: { cancel: () => void } | undefined

/** The watched files' modification times and sizes, as one string to compare. */
async function stampOf($: EngineInterface): Promise<string> {
  const paths = watchedPaths(await $.session.cwd(), (await $.env.get('HOME')) ?? '', await $.env.get('CLAUDE_CONFIG_DIR'))
  const parts = await Promise.all(paths.map(p => $.fs.stat(p).then(s => `${s.mtimeMs}:${s.size}`, () => '-')))
  return parts.join('|')
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function refresh($: EngineInterface) {
  // Before reading: a change made during the read shows at the next compare
  stamp = await stampOf($)
  // From the store each time: /clear resets the atom to hidden
  const isHidden = (await $.store.get(HIDDEN).catch(() => undefined)) !== false
  if ((await read($, hidden)) !== isHidden) await update($, hidden, () => isHidden)
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const env: SfEnv = {
    SF_TARGET_ORG: await $.env.get('SF_TARGET_ORG'),
    SFDX_DEFAULTUSERNAME: await $.env.get('SFDX_DEFAULTUSERNAME'),
    SF_TARGET_DEV_HUB: await $.env.get('SF_TARGET_DEV_HUB'),
    SFDX_DEFAULTDEVHUBUSERNAME: await $.env.get('SFDX_DEFAULTDEVHUBUSERNAME'),
  }
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
  const connected = connectedServers(usage?.context.breakdown?.mcpTools)
  // Also kept current by session.measure; read here so a reload or /clear draws it at once
  await setContext($, contextPercent(usage?.context))
  const readFile = fileReader($)
  const resolved = await resolveOrg(readFile, cwd, home, await $.clock.now(), env)
  // A login that isn't the Claude account's own, or a sandbox copy of it, is named on the line
  const email = await accountEmail(readFile, `${(await $.env.get('CLAUDE_CONFIG_DIR')) || home}/.claude.json`)
  const login = resolved === null ? undefined : otherLogin(resolved.username, email)
  const next = resolved !== null && login !== undefined ? { ...resolved, login } : resolved
  if (!same(await read($, org), next)) {
    await update($, org, () => next)
  }
  const servers = await resolveMcp(readFile, cwd, home, await $.clock.now(), await $.env.get('CLAUDE_CONFIG_DIR'), { env, connected, domains: await read($, domains) })
  if (!same(await read($, mcp), servers.hosted)) {
    await update($, mcp, () => servers.hosted)
  }
  if (!same(await read($, dx), servers.dx)) {
    await update($, dx, () => servers.dx)
  }
  // One read of the transcript per reset serves both
  const transcript = transcriptOnce($)
  try {
    await restoreSf($, transcript)
  } catch {
    // An unreadable transcript leaves the marker to the next sf command
  }
  try {
    await restoreSessionPr($, transcript)
  } catch {
    // An unreadable transcript leaves the session's pull request to the next command naming one
  }
}

export const register: Register = (on, options) => {
  looks = looksFrom(options)
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    const reached = await $.store.get(DOMAINS).catch(() => undefined)
    if (reached && typeof reached === 'object') await update($, domains, seen => ({ ...(reached as Record<string, SfDomain>), ...seen }))
    // Servers connecting, which changes no file
    ticker?.cancel()
    ticker = $.clock.every(REFRESH_MS, () => refresh($))
    // `sf config set target-org`, an alias or an MCP server changed in another
    // session or a terminal, as sf-headless-config watches
    watcher?.cancel()
    watcher = $.clock.every(WATCH_MS, () => {
      void (async () => {
        if ((await stampOf($)) !== stamp) await refresh($)
      })()
    })
    // The pull request draws when gh answers, and never holds the start up
    soon($, true)
    // Checks and reviews change with no local sign, so an open pull request is read again
    prTicker?.cancel()
    prTicker = $.clock.every(PR_MS, () => {
      void (async () => {
        const state = (await read($, pr))?.state
        if (state === 'open' || state === 'draft') await refreshPr($, true)
      })()
    })
    // Last, so the band draws even where commands can't be added
    await $.command.register({
      name: 'sf-headless-band',
      description: 'Show or hide the Salesforce band above the prompt (on, off, or toggle)',
      argumentHint: '[on|off]',
    })
    return started
  })

  // A hosted server's org, from the My Domain its calls carry, as sf-headless-config watches
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    const ran = await next(e)
    const parts = splitTool(e.tool)
    if (parts === undefined) return ran
    try {
      const entry = (await read($, mcp)).find(m => wireName(m.server) === parts.server)
      const { tool: _tool, tool_use_id: _id, ...args } = e as Record<string, unknown>
      const seen = entry === undefined ? undefined : (myDomainOf(JSON.stringify(args)) ?? myDomainOf(ran.text ?? ''))
      // Kept only where it fits the URL: never a sandbox's domain for a production URL's server
      const found = seen && entry && domainFits(entry.urlType, seen) ? seen : undefined
      const known = found && (await read($, domains))[entry!.domainKey]
      if (found && entry && (known?.host !== found.host || known?.type !== found.type)) {
        await update($, domains, all => ({ ...all, [entry.domainKey]: found }))
        const kept = await $.store.get(DOMAINS)
        await $.store.set(DOMAINS, { ...(kept && typeof kept === 'object' ? kept : {}), [entry.domainKey]: found })
        await refresh($)
      }
    } catch {
      // Watching never stands in a call's way
    }
    return ran
  }).catch(($, e, next) => next(e))

  // A pull request created, edited, merged or pushed to by a command: read it again at once, and
  // keep one the command named as the session's own
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const ran = await next(e)
    const git = (ran.result as { gitOperation?: { pr?: unknown; push?: unknown; branch?: unknown } } | undefined)?.gitOperation
    const named = prRefOf(ran.result)
    if (named !== undefined && !same(await read($, sessionPr), named)) await update($, sessionPr, () => named)
    if (git?.pr || git?.push || git?.branch) soon($, true)
    return ran
  }).catch(($, e, next) => next(e))

  // The orgs a command names for the Salesforce CLI, which the CLI line shows when they aren't the default
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const ran = await next(e)
    // A PreToolUse hook's refusal, read from the result's text: no classic.PreToolUse hook here,
    // since cc-plugin-sec-default takes that event first and this mod never saw the decision
    const wasRefused = isHookRefusal(e.tool, ran)
    // Every call that reached the tool counts, an errored one too: sf can reach the org before it
    // fails. A call a hook refused never ran; one the person declined at a prompt still counts
    if (ran.deny === undefined && !wasRefused) {
      try {
        await noteSf($, (e as { command?: unknown }).command)
      } catch {
        // Watching never stands in a call's way
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sf-headless-band' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isHidden = arg === 'on' || arg === 'show' ? false : arg === 'off' || arg === 'hide' ? true : !(await read($, hidden))
    await update($, hidden, () => isHidden)
    await $.store.set(HIDDEN, isHidden)
    // Not read while hidden
    if (!isHidden) soon($, true)
    return {
      text: isHidden
        ? 'Salesforce band hidden. /sf-headless-band brings it back.'
        : 'Salesforce band shown above the prompt. /sf-headless-band hides it.',
    }
  })

  // /clear, /resume and /branch reset $.state without a new session.start, and the 15 s tick draws
  // the band again: no classic.SessionStart hook, since cc-plugin-sec-default takes that event first
  on('classic.CwdChanged', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    soon($, true)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    // Only a changed branch, or an answer older than PR_MS, reaches GitHub
    soon($)
    return result
  })

  // The context window filling, after each response
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (e.changed.includes('context')) await setContext($, contextPercent(e.context))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const info = await read($, org)
    const used = await read($, context)
    const hosted = await read($, mcp)
    const dxServers = await read($, dx)
    const branchPr = await read($, pr)
    // The last sf command's orgs that aren't the default one
    const elsewhere = (await read($, lastSf)).filter(o => o.username !== info?.username)
    if (e.props.hasSurvey || (await read($, hidden)) || (info === null && hosted.length === 0 && dxServers.length === 0 && branchPr === null)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const lines = []

    // The org type as sf-headless-config draws it: its label on a solid pill
    const pill = (type: OrgType, label: string = ORG_TYPE_LABEL[type], key: string = label, color: string = ORG_TYPE_COLOR[type]) => (
      <Text key={key} backgroundColor={color} color="inverseText">
        {` ${label} `}
      </Text>
    )
    // An org's pill label and color: a shared sandbox's where it is one, else its type's
    const orgLook = (type: OrgType, host: string | undefined) => orgLabel(type, host, looks) ?? { label: ORG_TYPE_LABEL[type], color: ORG_TYPE_COLOR[type] }
    const orgPill = (type: OrgType, host: string | undefined, key?: string) => {
      const look = orgLook(type, host)
      return pill(type, look.label, key ?? look.label, look.color)
    }
    // One line: what it is, then › and its org type pills, then what follows them, each keyed and sized by its caller
    const row = (key: string, left: RenderChildren, pills: RenderChildren[], tail: RenderChildren[] = []) => (
      <Box key={key} flexDirection="row">
        <Box flexDirection="row" flexShrink={1}>
          {left}
        </Box>
        {pills.length === 0 ? null : <Text dimColor> › </Text>}
        {pills.length === 0 ? null : (
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {pills}
          </Box>
        )}
        {tail}
      </Box>
    )

    if (info !== null) {
      const expiry =
        info.daysLeft === undefined
          ? null
          : info.daysLeft === 0
            ? 'expires today'
            : `expires in ${info.daysLeft} day${info.daysLeft === 1 ? '' : 's'}`
      const isExpiring = info.daysLeft !== undefined && info.daysLeft <= 3
      // The prefix only tells this line from the MCP lines, so it shows only beside them
      const prefix = hosted.length > 0 || dxServers.length > 0 ? 'sf › cli › ' : ''
      const domain = info.host && !repeatsAlias(info.name, info.host) ? domainName(info.host) : undefined
      // Each org's name in its color, with no pill or type word: orange production, yellow shared QA sandbox, green any other sandbox
      const orgName = (o: OrgInfo, key: string) => (
        <Text key={key} bold color={nameColor(o.type, o.host, looks)}>
          {o.name}
        </Text>
      )

      // default org: alias › my-domain › as login@ › local config › expires in N days · last target: alias · context used: N%
      // The labels show at every width: in a window too narrow for the line, its end runs past the edge
      lines.push(
        <Box key="sf" flexDirection="row">
          <Box flexDirection="row" flexShrink={0}>
            {prefix === '' ? null : <Text dimColor>{prefix}</Text>}
            <Text dimColor>{ORG_LABEL}</Text>
            {orgName(info, 'default-org')}
          </Box>
          {domain === undefined && !info.login && !info.isLocal && expiry === null ? null : (
            <Box flexDirection="row" flexShrink={0}>
              {domain === undefined ? null : <Text dimColor> › {domain}</Text>}
              {info.login ? <Text dimColor> › </Text> : null}
              {info.login ? (
                <Text bold color="warning">
                  as {info.login}
                </Text>
              ) : null}
              {info.isLocal ? <Text dimColor> › </Text> : null}
              {info.isLocal ? (
                <Text bold color="warning">
                  local config
                </Text>
              ) : null}
              {expiry === null ? null : <Text dimColor> › </Text>}
              {expiry === null ? null : isExpiring ? <Text color="error">{expiry}</Text> : <Text dimColor>{expiry}</Text>}
            </Box>
          )}
          {/* Where the last sf command went, when it named an org that isn't the default: each name in its
              color. Plain Texts only, since the desktop wrapped and then emptied a Text holding others. Spaces are
              in the text, not a gap or margin, which the desktop draws wider than a space */}
          {elsewhere.length === 0 ? null : (
            <Box key="last-sf" flexDirection="row" flexShrink={0}>
              <Text dimColor>{MARKER_LABEL}</Text>
              {elsewhere.flatMap((o, i) => [
                i === 0 ? null : <Text key={`last-gap-${o.username}`}> </Text>,
                orgName(o, `last-${o.username}`),
              ])}
            </Box>
          )}
          {/* How full the context window is, at the line's end once a response has reported it */}
          {used === null ? null : (
            <Box key="context" flexDirection="row" flexShrink={0}>
              <Text dimColor>{CONTEXT_LABEL}</Text>
              <Text bold color={contextColor(used)}>{`${used}%`}</Text>
            </Box>
          )}
        </Box>,
      )
    }

    // pr › #N › state › review › each gate not passed › checks › conflicts, for the branch's pull request
    if (branchPr !== null) {
      const isOpen = branchPr.state === 'open' || branchPr.state === 'draft'
      const parts: RenderChildren[] = [
        branchPr.state === 'merged' ? (
          <Text key="state" color="success">
            merged
          </Text>
        ) : (
          <Text key="state" dimColor>
            {branchPr.state}
          </Text>
        ),
      ]
      // Once merged or closed, its reviews and checks no longer matter
      if (isOpen) {
        if (branchPr.review !== undefined) {
          parts.push(
            <Text key="review" color={branchPr.review === 'approved' ? 'success' : 'error'}>
              {branchPr.review}
            </Text>,
          )
        }
        for (const words of branchPr.waiting) {
          parts.push(
            <Text key={`gate-${words}`} color="warning">
              {words}
            </Text>,
          )
        }
        if (branchPr.failing.length > 0) {
          parts.push(
            <Text key="checks" bold color="error">
              {failingText(branchPr.failing)}
            </Text>,
          )
        } else if (branchPr.running > 0) {
          parts.push(
            <Text key="checks" dimColor>
              {`${branchPr.running} check${branchPr.running === 1 ? '' : 's'} running`}
            </Text>,
          )
        } else if (branchPr.passed > 0) {
          parts.push(
            <Text key="checks" color="success">
              checks ✓
            </Text>,
          )
        }
        if (branchPr.conflicts) {
          parts.push(
            <Text key="conflicts" bold color="error">
              conflicts
            </Text>,
          )
        }
      }
      lines.push(
        row(
          'pr',
          <Box flexDirection="row">
            <Text dimColor>pr › </Text>
            <Text bold>{`#${branchPr.number}`}</Text>
            {parts.map((part, i) => (
              <Box key={`part-${i}`} flexDirection="row">
                <Text dimColor> › </Text>
                {part}
              </Box>
            ))}
          </Box>,
          [],
        ),
      )
    }

    // ✓ or ✗: whether the session has the server's tools
    const connection = (isConnected: boolean) =>
      isConnected ? <Text color="success">✓ </Text> : <Text color="error">✗ </Text>

    // sf › mcp › ✓ server › alias, alias › my-domain, my-domain › [ type ] [ type ], one line per DX MCP Server in use
    for (const server of dxServers) {
      const names = server.orgs.map(o => o.name).join(', ')
      const domains = server.orgs.flatMap(o => (o.host ? [domainName(o.host)] : [])).join(', ')
      const pills = server.orgs.map(o => orgPill(o.type, o.host, o.username))
      if (server.allOrgs) pills.push(pill('production', 'all orgs'))
      lines.push(
        row(
          `dx-${server.server}`,
          <Box flexDirection="row">
            <Text dimColor>sf › mcp › </Text>
            {connection(server.isConnected)}
            <Text>{server.server}</Text>
            <Text dimColor> › </Text>
            {names === '' ? null : <Text bold>{names}</Text>}
            {domains === '' ? null : <Text dimColor> › {domains}</Text>}
            {names === '' && !server.allOrgs ? <Text dimColor>no org set</Text> : null}
            {names === '' && server.allOrgs ? <Text bold>every org the CLI knows</Text> : null}
          </Box>,
          pills,
        ),
      )
    }

    // sf › mcp › ✓ server, ✗ server › my-domain › [ type ], one line per org: servers of one type
    // sharing a consumer key reach the same org; a server with no key stands alone
    const groups = new Map<string, McpOrg[]>()
    for (const m of [...hosted].sort((a, b) => RISK.indexOf(a.type) - RISK.indexOf(b.type))) {
      // By the URL's kind, not the type: servers whose org isn't known yet still group by their app
      const key = `${m.urlType}|${m.clientId ?? `server:${m.server}`}`
      groups.set(key, [...(groups.get(key) ?? []), m])
    }
    for (const [key, group] of groups) {
      lines.push(
        row(
          `mcp-${key}`,
          <Box flexDirection="row">
            <Text dimColor>sf › mcp › </Text>
            {group.map((m, i) => (
              <Box key={m.server} flexDirection="row">
                {i === 0 ? null : <Text dimColor>, </Text>}
                {connection(m.isConnected)}
                <Text bold>{m.server}</Text>
              </Box>
            ))}
            {group[0]!.host ? <Text dimColor> › {domainName(group[0]!.host)}</Text> : null}
          </Box>,
          // No take on the type until a call has shown the org
          group[0]!.host ? [orgPill(group[0]!.type, group[0]!.host)] : [],
        ),
      )
    }

    const line = lines.length === 1 ? lines[0]! : <Box flexDirection="column">{lines}</Box>

    // The band is shared: keep what the mods after this one draw there
    const theirs = await next(e)
    return theirs ? (
      <Box flexDirection="column">
        {line}
        {theirs}
      </Box>
    ) : (
      line
    )
  })
}
