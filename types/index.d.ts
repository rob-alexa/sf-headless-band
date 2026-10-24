/** SfOrgType from hooks/salesforce.ts, written out because this contract can't import. */
export type OrgType = 'production' | 'developer' | 'sandbox' | 'scratch' | 'unknown'

export type OrgInfo = {
  /** The alias when the target org is one, else the username. */
  name: string
  username: string
  type: OrgType
  /** Its My Domain host, from the CLI's auth file. */
  host?: string
  /** Days until a scratch org expires; undefined for any other type. */
  daysLeft?: number
  /** True when the project's own config sets the default org, overriding the global one. */
  isLocal?: boolean
  /** The login's name part (`devops@`) when it isn't the Claude account's own or a sandbox copy of it. */
  login?: string
}

/** A pull request a shell command in the session created or acted on, as the tool's `gitOperation.pr` names it. */
export type PrRef = {
  number: number
  /** Its URL, when the command's output carried one; `gh pr view` takes it in place of the number. */
  url?: string
}

/** The pull request the band shows, as `gh pr view` reports it. */
export type PrInfo = {
  number: number
  state: 'open' | 'draft' | 'merged' | 'closed'
  /** From the latest reviews: any changes requested wins over an approval. */
  review?: 'approved' | 'changes requested'
  /** The words for each gate (a review, QA) that has not passed yet, in the gates' own order. */
  waiting: string[]
  /** The checks that failed, by name, gates left out. */
  failing: string[]
  /** How many checks are still running or pending, gates left out. */
  running: number
  /** How many checks passed, gates left out. */
  passed: number
  /** True when GitHub reports a merge conflict; false too while it is still working that out. */
  conflicts: boolean
}

/** A Salesforce Hosted MCP server, signed in with OAuth through an External Client App. */
export type McpOrg = {
  /** The server's name as /mcp lists it. */
  server: string
  /** The org's type: unknown until a call carries its My Domain, then production or developer edition, sandbox or scratch. */
  type: OrgType
  /** The URL's own kind: a `/sandbox/` path serves sandbox and scratch orgs alike. */
  urlType: 'production' | 'sandbox'
  /** What its org is remembered by, shared by every server signed in through one app. */
  domainKey: string
  /** The My Domain its calls carried, once one has. */
  host?: string
  /** The External Client App's consumer key; servers sharing one reach the same org. */
  clientId?: string
  /** True while the session has tools from it. */
  isConnected: boolean
}

/** A Salesforce DX MCP Server, which reaches orgs through the Salesforce CLI's auth files. */
export type DxMcp = {
  /** The server's name as /mcp lists it. */
  server: string
  /** The orgs its `--orgs` allows, DEFAULT_TARGET_ORG and DEFAULT_TARGET_DEV_HUB resolved. */
  orgs: OrgInfo[]
  /** True when `--orgs` includes ALLOW_ALL_ORGS: every org the CLI has authorized. */
  allOrgs: boolean
  /** The riskiest type it can reach; ALLOW_ALL_ORGS counts as production. */
  type: OrgType
  /** True while the session has tools from it. */
  isConnected: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'sf-headless-band': {
      org: OrgInfo | null
      /** The Salesforce Hosted MCP servers configured for the session's folder. */
      mcp: McpOrg[]
      /** The Salesforce DX MCP Servers configured for the session's folder. */
      dx: DxMcp[]
      /** The My Domain each hosted server's calls carried, by its domain key; kept in the store. */
      domains: Record<string, { host: string; type: OrgType }>
      /** Switched off with /sf-headless-band; kept in the store across sessions. */
      hidden: boolean
      /** How full the context window is, as a whole percentage; null until a response reports it. */
      context: number | null
      /** The pull request for the session folder's branch, else the session's own; null when neither has one or gh can't say. */
      pr: PrInfo | null
      /** The newest pull request a shell command in the session created or acted on; null when none has. */
      sessionPr: PrRef | null
      /** The orgs the session's last sf command named, riskiest first; empty when it named none. */
      lastSf: OrgInfo[]
    }
  }
}
