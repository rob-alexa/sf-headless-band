// This fork's addition: the pull request for the session folder's branch, else the one
// the session's own commands last created or acted on, read with `gh pr view`. The only part of
// the band that starts a process or reaches the network, and it does both only through
// read-only `git` and `gh` commands.

import type { PrInfo, PrRef } from '../types'

const SHELL_TOOLS = /^(Bash|PowerShell)$/

/**
 * The pull request a shell tool's result names in `gitOperation.pr` (created, edited, merged,
 * commented on, closed, reopened, marked ready or draft), or undefined when it names none.
 */
export const prRefOf = (result: unknown): PrRef | undefined => {
  const named = (result as { gitOperation?: { pr?: { number?: unknown; url?: unknown } } } | null | undefined)?.gitOperation?.pr
  if (typeof named?.number !== 'number') return undefined
  return typeof named.url === 'string' ? { number: named.number, url: named.url } : { number: named.number }
}

/** The newest pull request a shell command in the transcript created or acted on, or undefined when none has. */
export const lastSessionPr = (messages: readonly { toolUses: readonly { tool: string; result?: unknown }[] }[]): PrRef | undefined => {
  for (let m = messages.length - 1; m >= 0; m--) {
    const uses = messages[m]!.toolUses
    for (let u = uses.length - 1; u >= 0; u--) {
      const use = uses[u]!
      const ref = SHELL_TOOLS.test(use.tool) ? prRefOf(use.result) : undefined
      if (ref !== undefined) return ref
    }
  }
  return undefined
}

/** The fields `gh pr view --json` is asked for. */
export const PR_FIELDS = 'number,state,isDraft,mergeable,latestReviews,statusCheckRollup'

// A finished check run's conclusions that count as failed; any other finished one passed
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

type Standing = 'passed' | 'failed' | 'running'

type Check = { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }

/** How one check stands: a commit status by its state, a check run by its status and conclusion. */
const standing = (check: Check): Standing => {
  if (check.__typename === 'StatusContext' || check.state !== undefined) {
    return check.state === 'SUCCESS' ? 'passed' : check.state === 'FAILURE' || check.state === 'ERROR' ? 'failed' : 'running'
  }
  if (check.status !== 'COMPLETED') return 'running'
  return FAILED.has(check.conclusion ?? '') ? 'failed' : 'passed'
}

/**
 * The band's reading of `gh pr view --json` output, or null when it is not a pull request.
 * `gates` maps each commit status that stands for a person's step (a review, QA) to the words
 * shown while it has not passed; gates are kept out of the checks' counts.
 */
export const prOf = (text: string, gates: Record<string, string>): PrInfo | null => {
  let view: Record<string, unknown>
  try {
    view = JSON.parse(text)
  } catch {
    return null
  }
  if (view === null || typeof view !== 'object' || typeof view.number !== 'number') return null

  const state = view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : view.isDraft === true ? 'draft' : 'open'
  const reviews = Array.isArray(view.latestReviews) ? view.latestReviews.map(r => (r as { state?: string } | null)?.state) : []
  const review = reviews.includes('CHANGES_REQUESTED') ? 'changes requested' : reviews.includes('APPROVED') ? 'approved' : undefined

  // By name: a check that ran for more than one event is listed more than once, and one failure fails it
  const checks = new Map<string, Standing>()
  const open = new Set<string>()
  for (const item of Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : []) {
    const check = (item ?? {}) as Check
    const name = check.name ?? check.context
    if (typeof name !== 'string') continue
    const now = standing(check)
    if (Object.hasOwn(gates, name)) {
      if (now !== 'passed') open.add(name)
      continue
    }
    const was = checks.get(name)
    checks.set(name, was === 'failed' || now === 'failed' ? 'failed' : was === 'running' || now === 'running' ? 'running' : 'passed')
  }
  const all = [...checks]

  return {
    number: view.number,
    state,
    ...(review === undefined ? {} : { review }),
    waiting: Object.entries(gates).flatMap(([name, words]) => (open.has(name) ? [words] : [])),
    failing: all.filter(([, s]) => s === 'failed').map(([name]) => name),
    running: all.filter(([, s]) => s === 'running').length,
    passed: all.filter(([, s]) => s === 'passed').length,
    conflicts: view.mergeable === 'CONFLICTING',
  }
}

/** The failing checks as the band names them: the first two, then how many more. */
export const failingText = (failing: readonly string[]): string =>
  failing.length <= 2 ? `✗ ${failing.join(', ')}` : `✗ ${failing.slice(0, 2).join(', ')} +${failing.length - 2}`
