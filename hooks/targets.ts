// This fork's own: the orgs a shell command names for the Salesforce CLI, read from the command's
// text alone, so the band can show when the last one was not the default org. Nothing is run.

// Between two simple commands: ; & | ( ) a newline or a backtick
const SEP = '\u0000'

// A bash heredoc's opening marker, never the <<< of a here-string
const HEREDOC = /(?<!<)<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1/
// A PowerShell here-string, @'…'@ or @"…"@, whose lines are text
const HERE_STRING = /@(['"])\r?\n[\s\S]*?\r?\n\1@/g

/** A command with each heredoc's body taken out: its lines are text, not commands. */
const dropHeredocs = (command: string): string => {
  let out = ''
  let rest = command
  for (;;) {
    const marker = HEREDOC.exec(rest)
    const lineEnd = marker === null ? -1 : rest.indexOf('\n', marker.index)
    if (marker === null || lineEnd < 0) return out + rest
    out += rest.slice(0, lineEnd + 1)
    const body = rest.slice(lineEnd + 1)
    const close = new RegExp(`^[ \\t]*${marker[2]}[ \\t]*$`, 'm').exec(body)
    rest = close === null ? '' : body.slice(close.index + close[0].length)
  }
}

/**
 * A shell command's words with their quotes taken off and SEP between simple commands.
 * A backslash escapes only what a shell would need escaping, so a Windows path keeps its own.
 */
export const shellWords = (command: string): string[] => {
  const text = dropHeredocs(command).replace(HERE_STRING, ' ')
  const words: string[] = []
  let word = ''
  let isWord = false
  let quote: string | undefined
  const end = () => {
    if (isWord) words.push(word)
    word = ''
    isWord = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const after = text[i + 1]
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && after !== undefined && '"\\$`'.includes(after)) word += text[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      isWord = true
    } else if (c === '\\' && after === '\n') {
      // A line continued
      i++
    } else if (c === '\\' && after !== undefined && ' \t"\'\\$`;&|()'.includes(after)) {
      word += text[++i]
      isWord = true
    } else if (c === ' ' || c === '\t' || c === '\r') {
      end()
    } else if (';&|()\n`'.includes(c)) {
      // $( starts a command of its own
      if (c === '(' && word.endsWith('$')) word = word.slice(0, -1)
      end()
      words.push(SEP)
    } else {
      word += c
      isWord = true
    }
  }
  end()
  return words
}

// The Salesforce CLI, by name or path
const SF = /(^|[/\\])(sf|sfdx)(\.cmd|\.exe)?$/i
// The flags that name the org an sf command reaches
const SF_FLAGS = ['-o', '--target-org', '-u', '--target-username', '--targetusername']
// The flags an org-touching script takes
const SCRIPT_FLAGS = ['--target-org', '--org']

/** Whether a command's name is the Salesforce CLI, or one of the person's wrappers for it (the `sfWrappers` setting). */
const isSf = (name: string, wrappers: readonly string[]): boolean => {
  if (SF.test(name)) return true
  const base = name.split(/[/\\]/).pop()!.replace(/\.(cmd|exe)$/i, '').toLowerCase()
  return wrappers.some(w => w.toLowerCase() === base)
}
// Words that run the command after them
const PREFIXES = new Set(['time', 'command', 'exec', 'nohup', 'env', 'xargs', 'sudo', 'then', 'do', 'else', 'if', 'elif', 'while', 'until', '!', '{', '}'])
// Shells that run a command given as one word
const SHELLS = /(^|[/\\])(bash|sh|pwsh|powershell)(\.exe)?$/i
// The environment variables that set the default org, as a bash or PowerShell assignment
const ENV_ORG = /^(\$env:)?(SF_TARGET_ORG|SFDX_DEFAULTUSERNAME)=(.*)$/i
const PS_ENV_ORG = /^\$env:(SF_TARGET_ORG|SFDX_DEFAULTUSERNAME)$/i
// sf topics that work on this machine alone and reach no org
const ORGLESS = new Set(['alias', 'autocomplete', 'commands', 'config', 'doctor', 'help', 'info', 'plugins', 'search', 'template', 'update', 'version', 'whatsnew', 'which'])
const ORGLESS_PAIRS = new Set(['org list', 'org login', 'org logout', 'project convert'])

/** The value of `-o value` or `--target-org=value`, the first of `flags` the words carry. */
const flagIn = (args: readonly string[], flags: readonly string[]): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (flags.includes(arg)) return args[i + 1]
    const flag = flags.find(f => arg.startsWith(`${f}=`))
    if (flag !== undefined) return arg.slice(flag.length + 1)
  }
  return undefined
}

/** Whether an sf command naming no org works on this machine alone: config, aliases, help, a generator. */
const isOrgless = (args: readonly string[]): boolean => {
  if (args.some(a => a === '--help' || a === '-h' || a === '--version')) return true
  const topic = args.filter(a => !a.startsWith('-')).slice(0, 2)
  if (topic.length === 0) return true
  return ORGLESS.has(topic[0]!) || topic[1] === 'generate' || ORGLESS_PAIRS.has(topic.join(' '))
}

/**
 * The orgs a shell command names for the Salesforce CLI or one of `wrappers`, by `-o`,
 * `--target-org` or an SF_TARGET_ORG set in the command, and for a `.sh` script by
 * `--target-org` or `--org`. An empty list when it runs sf on the default org alone; undefined
 * when it reaches no org through sf at all, which leaves the last answer standing. What a
 * variable holds is not known, so `-o "$ORG"` names `$ORG`; a command quoted inside another's
 * argument is not read, except a shell's `-c` command.
 */
export const sfTargets = (command: string, wrappers: readonly string[] = []): string[] | undefined => {
  const words = shellWords(command)
  let reached = false
  const targets: string[] = []
  // SF_TARGET_ORG exported earlier in the command, or set with $env: in PowerShell
  let exported: string | undefined
  for (let start = 0; start < words.length; ) {
    let stop = start
    while (stop < words.length && words[stop] !== SEP) stop++
    const cmd = words.slice(start, stop)
    start = stop + 1

    // SF_TARGET_ORG=x before the command reaches only that command
    let prefixed: string | undefined
    let at = 0
    for (; at < cmd.length; at++) {
      const word = cmd[at]!
      const env = ENV_ORG.exec(word)
      if (env !== null && env[1] !== undefined) exported = env[3]
      else if (env !== null) prefixed = env[3]
      else if (!/^[A-Za-z_]\w*=/.test(word) && !PREFIXES.has(word)) break
    }
    const name = cmd[at]
    if (name === undefined) continue
    const args = cmd.slice(at + 1)

    if (name === 'export') {
      for (const word of args) {
        const env = ENV_ORG.exec(word)
        if (env !== null) exported = env[3]
      }
    } else if (PS_ENV_ORG.test(name) && args[0] === '=' && args[1] !== undefined) {
      exported = args[1]
    } else if (isSf(name, wrappers)) {
      // A named org always counts: `sf org generate password -o prod` reaches prod
      const named = flagIn(args, SF_FLAGS)
      if (named === undefined && isOrgless(args)) continue
      reached = true
      const target = named ?? prefixed ?? exported
      if (target !== undefined && target !== '') targets.push(target)
    } else if (SHELLS.test(name)) {
      const inner = flagIn(args, ['-c', '-Command', '-command'])
      const script = args.find(a => a.endsWith('.sh'))
      const found = inner !== undefined ? sfTargets(inner, wrappers) : script !== undefined ? scriptTargets(args.slice(args.indexOf(script) + 1)) : undefined
      if (found !== undefined) {
        reached = true
        targets.push(...found)
      }
    } else if (name.endsWith('.sh')) {
      const found = scriptTargets(args)
      if (found !== undefined) {
        reached = true
        targets.push(...found)
      }
    }
  }
  return reached ? targets : undefined
}

/** A script's org, when its words name one; a script naming none may reach no org at all. */
const scriptTargets = (args: readonly string[]): string[] | undefined => {
  const target = flagIn(args, SCRIPT_FLAGS)
  return target === undefined || target === '' ? undefined : [target]
}

// The shell tools whose commands can run sf
export const SHELL_TOOLS = /^(Bash|PowerShell)$/

/**
 * Whether an errored result is a PreToolUse hook's refusal as the model reads it
 * (`PreToolUse:Bash hook error: …`), the only sign of a refusal this mod reads: it hooks no
 * classic.PreToolUse, which another plugin takes first. Optionally inside a `<tool_use_error>` tag.
 */
export const isHookRefusal = (tool: string, ran: { isError?: true; text?: string }): boolean =>
  ran.isError === true && typeof ran.text === 'string' && ran.text.replace(/^\s*(<tool_use_error>)?\s*/, '').startsWith(`PreToolUse:${tool} hook error`)

/** A call as the transcript holds it, one of `$.session.messages()`'s `toolUses`. */
type TranscriptCall = { tool: string; input: Record<string, unknown>; text?: string; isError?: true }

/**
 * The newest shell command in the transcript that reached an org through sf and that no hook
 * refused, or undefined when there is none. A call still in flight has no `text` and is passed
 * over: `tool.call` notes it when it ends.
 */
export const lastSfCommand = (messages: readonly { toolUses: readonly TranscriptCall[] }[], wrappers: readonly string[] = []): string | undefined => {
  for (let m = messages.length - 1; m >= 0; m--) {
    const uses = messages[m]!.toolUses
    for (let u = uses.length - 1; u >= 0; u--) {
      const use = uses[u]!
      const command = use.input.command
      if (!SHELL_TOOLS.test(use.tool) || typeof command !== 'string' || use.text === undefined) continue
      if (!isHookRefusal(use.tool, use) && sfTargets(command, wrappers) !== undefined) return command
    }
  }
  return undefined
}
