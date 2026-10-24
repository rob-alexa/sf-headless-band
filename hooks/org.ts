import type { OrgInfo } from '../types'
import { resolveSfOrg, sfDefaults } from './salesforce'
import type { ReadFile, SfEnv, SfOrg } from './salesforce'

export { daysUntil, findProject, readJson } from './salesforce'
export type { ReadFile, SfEnv } from './salesforce'

/** An org the CLI can name, in the band's shape; undefined when no default is set. */
export const toOrgInfo = (org: SfOrg): OrgInfo | undefined =>
  org.name === undefined || org.username === undefined
    ? undefined
    : { name: org.name, username: org.username, type: org.type, ...(org.host ? { host: org.host } : {}), daysLeft: org.daysLeft }

/**
 * The default org for `cwd`, as a DX server's DEFAULT_TARGET_ORG resolves it: the
 * project's config, else the global one; null when neither sets one.
 */
export const resolveOrg = async (
  read: ReadFile,
  cwd: string,
  home: string,
  now: number,
  env: SfEnv = {},
): Promise<OrgInfo | null> => {
  const defaults = await sfDefaults(read, cwd, home, env)
  if (defaults.org === undefined) return null
  const info = toOrgInfo(await resolveSfOrg(read, home, defaults, 'DEFAULT_TARGET_ORG', now))
  if (info === undefined) return null
  // A project's own config overrides the global default the person may think is in force
  return defaults.orgFrom === 'project' ? { ...info, isLocal: true } : info
}
