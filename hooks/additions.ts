// This fork's additions, kept in their own file so the upstream files stay easy to compare:
// shared sandboxes and review gates from the person's own settings (the manifest's userConfig),
// a labeled CLI line that names a login not your own, and the context figure.

import type { PluginOptions } from 'claude-code'

import type { OrgType } from '../types'
import { ORG_TYPE_COLOR, readJson } from './salesforce'
import type { ReadFile } from './salesforce'

/** What the person's own settings add to the band; none of it ships in the mod. */
export type Looks = {
  /** My Domain names (`acme--uat`) of sandboxes a whole team shares, lowercased. */
  shared: ReadonlySet<string>
  /** The pill's words for a shared sandbox. */
  sharedLabel: string
  /**
   * Commit statuses that stand for a person's step (a review, QA), by the words the PR line
   * shows while each has not passed. Where a repo requires no approvals, GitHub's own review
   * decision stays blank, so these are where review and QA state live.
   */
  gates: Record<string, string>
  /** Commands that wrap the Salesforce CLI, by name (`sfw`), read for the last target as `sf` is. */
  sfWrappers: string[]
}

/** A list option's entries, trimmed, blanks dropped; a plain string is read as comma-separated. */
const entries = (value: PluginOptions[string] | undefined): string[] =>
  (Array.isArray(value) ? [...value] : typeof value === 'string' ? value.split(',') : []).map(s => String(s).trim()).filter(s => s !== '')

/** The looks from the userConfig options `sharedSandboxes`, `sharedSandboxLabel`, `gates` (`<status>=<words>`), and `sfWrappers`. */
export const looksFrom = (options: PluginOptions): Looks => {
  const label = typeof options.sharedSandboxLabel === 'string' ? options.sharedSandboxLabel.trim() : ''
  const gates: Record<string, string> = {}
  for (const entry of entries(options.gates)) {
    const at = entry.indexOf('=')
    const status = entry.slice(0, at).trim()
    const words = entry.slice(at + 1).trim()
    if (at > 0 && status !== '' && words !== '') gates[status] = words
  }
  return {
    shared: new Set(entries(options.sharedSandboxes).map(s => s.toLowerCase())),
    sharedLabel: label === '' ? 'shared sandbox' : label,
    gates,
    sfWrappers: entries(options.sfWrappers),
  }
}

/** The label for an org's pill, if it has one; never for production, whose red pill always shows. */
export const orgLabel = (type: string, host: string | undefined, looks: Looks): { label: string; color: string } | undefined =>
  type === 'production' || host === undefined || !looks.shared.has(host.split('.')[0]!.toLowerCase())
    ? undefined
    : { label: looks.sharedLabel, color: 'warning' }

/**
 * The color of an org's name on the CLI line: orange for production, yellow for a shared
 * sandbox, green for any other sandbox (each developer's own), else its type's.
 */
export const nameColor = (type: OrgType, host: string | undefined, looks: Looks): string =>
  type === 'production' ? 'claude' : (orgLabel(type, host, looks)?.color ?? (type === 'sandbox' ? 'success' : ORG_TYPE_COLOR[type]))

/** Whether a My Domain name only repeats the alias: `acme--dev` for `dev`. */
export const repeatsAlias = (name: string, host: string): boolean => {
  const domain = host.split('.')[0]!.toLowerCase()
  const alias = name.toLowerCase()
  return domain === alias || domain.endsWith(`--${alias}`)
}

/** The Claude account's email, from the login record in Claude Code's own config file. */
export const accountEmail = async (read: ReadFile, claudeFile: string): Promise<string | undefined> => {
  const email = (await readJson(read, claudeFile))?.oauthAccount?.emailAddress
  return typeof email === 'string' && email !== '' ? email : undefined
}

/**
 * The login to name beside an org, as `devops@`: only when it is neither the account's
 * own email nor a sandbox copy of it (`<email>.dev`), and never when the account is unknown.
 */
export const otherLogin = (username: string, email: string | undefined): string | undefined => {
  if (email === undefined || !username.includes('@')) return undefined
  const user = username.toLowerCase()
  const own = email.toLowerCase()
  return user === own || user.startsWith(`${own}.`) ? undefined : `${username.split('@')[0]}@`
}

/** How full the context window is, as a whole percentage; null before a response has reported a fill. */
export const contextPercent = (context: { tokens?: number; window: number; percent?: number } | undefined): number | null => {
  if (context === undefined) return null
  if (context.percent !== undefined) return context.percent
  return context.tokens !== undefined && context.window > 0 ? Math.round((context.tokens / context.window) * 100) : null
}

/** The words before the default org's name on the CLI line. */
export const ORG_LABEL = 'default org: '

/** The last-target marker's words, before its orgs, spaced in the text: the desktop draws a gap or margin wider than a space. */
export const MARKER_LABEL = ' · last target: '

/** The context figure's words, at the CLI line's end, before the percentage in its color, spaced as the marker's. */
export const CONTEXT_LABEL = ' · context used: '

/** The context percentage's color: green below 30%, yellow from 30%, orange from 40%. */
export const contextColor = (percent: number): 'success' | 'warning' | 'claude' =>
  percent >= 40 ? 'claude' : percent >= 30 ? 'warning' : 'success'
