import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const HOME = '/home/me'
const PROJECT = '/work/app'

// What Claude Code passes to a ui.render hook for the band, apart from the surface
const BAND = {
  plugin: 'sf-headless-band',
  component: 'AbovePrompt',
  viewport: { columns: 100, rows: 30 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 95,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// On Windows the engine hands fs a drive-letter path: back to the POSIX one these tests name
const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

// A scratch org that expires 2 days after the mock clock's start
const FILES: Record<string, unknown> = {
  [`${PROJECT}/sfdx-project.json`]: {},
  [`${PROJECT}/.sf/config.json`]: { 'target-org': 'my-scratch' },
  [`${HOME}/.sfdx/alias.json`]: { orgs: { 'my-scratch': 'test-1@example.com' } },
  [`${HOME}/.sfdx/test-1@example.com.json`]: {
    isScratch: true,
    expirationDate: '2026-10-08',
    instanceUrl: 'https://speedy-1-dev-ed.scratch.my.salesforce.com',
  },
}

// The band starts off; most tests begin with it switched on in an earlier session
const stubSession = (on: Parameters<TestBody>[1], cwd: string, files = FILES, env: Record<string, string> = {}, store: Record<string, unknown> = { hidden: false }) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T12:00:00Z') })
  mock.env(on, { HOME, ...env })
  mock.store(on, store)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: cwd }))
  on('fs.read', ($, e) =>
    posix(e.path) in files ? { value: JSON.stringify(files[posix(e.path)]) } : { deny: 'ENOENT' },
  )
  on('session.start', () => ({ cwd }))
  // Stands for what other mods draw in the shared band
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['another mod'] }))
  return clock
}

test('in a Salesforce project the band shows the org, its type and expiry', async ($, on) => {
  stubSession(on, `${PROJECT}/force-app`)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: `${PROJECT}/force-app` })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
    // Named by its alias and its My Domain, as a hosted server is; the username is the pane's
    expect(await ui.find({ type: 'Text', text: ' › speedy-1-dev-ed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /test-1@example\.com/ })).toBeUndefined()
    // No dot and no pill: the name's own color says the org type
    expect(await ui.find({ type: 'Text', text: /●/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ' scratch ' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^my-scratch$/ })).toMatchObject({ props: { bold: true, color: 'success' } })
    expect(await ui.find({ type: 'Text', text: /expires in 2 days/ })).toBeDefined()
    // Other mods' band content is kept
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    await ui.unmount()
  }
})

test('outside a Salesforce project the band is left to others', async ($, on) => {
  stubSession(on, '/work/plain')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /my-scratch/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    await ui.unmount()
  }
})

test("a production org's name is solid orange and holds still", async ($, on) => {
  const prod = {
    [`${PROJECT}/sfdx-project.json`]: {},
    [`${PROJECT}/.sf/config.json`]: { 'target-org': 'me@acme.com' },
    [`${HOME}/.sfdx/me@acme.com.json`]: { isScratch: false, isSandbox: false },
  }
  const clock = stubSession(on, PROJECT, prod)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const nameColor = async () => (await ui.find({ type: 'Text', text: /^me@acme\.com$/ }))?.props?.color
  // No alias, so the username is not repeated in brackets
  expect(await ui.find({ type: 'Text', text: /\(me@acme.com\)/ })).toBeUndefined()
  expect(await nameColor()).toBe('claude')
  await clock.advance(600)
  expect(await nameColor()).toBe('claude')
  await ui.unmount()
})

test('hosted MCP servers show outside a Salesforce project, with no type until a call shows their org', async ($, on) => {
  const oauth = { clientId: '3MVG9-consumer-key', callbackPort: 38000 }
  const files = {
    [`${HOME}/.claude.json`]: {
      projects: {
        '/work/plain': {
          mcpServers: {
            'sobject-all': { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all', oauth },
            'metadata-experts': {
              type: 'http',
              url: 'https://api.salesforce.com/platform/mcp/v1/sandbox/platform/metadata-experts',
              oauth,
            },
          },
        },
      },
    },
  }
  const clock = stubSession(on, '/work/plain', files)
  on('tool.call', () => ({ result: 'x', text: 'ok' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'sobject-all' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'metadata-experts' })).toBeDefined()
    // No take on the type from the URL: no pill, and no dangling separator
    expect(await ui.find({ type: 'Text', text: ' production ' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: ' sandbox ' })).toBeUndefined()
    expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ sobject-all$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'sf › cli › ' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()
    await ui.unmount()
  }

  // Once a call shows the org is production: a solid red pill that holds still
  await $.tool.call({ tool: 'mcp__sobject-all__soqlQuery', url: 'https://acme.my.salesforce.com/services/data' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const pillColor = async () => (await ui.find({ type: 'Text', text: ' production ' }))?.props?.backgroundColor
  expect(await pillColor()).toBe('error')
  await clock.advance(600)
  expect(await pillColor()).toBe('error')
})

test('hosted MCP servers share a line only when they share a consumer key', async ($, on) => {
  const url = (server: string) => `https://api.salesforce.com/platform/mcp/v1/platform/${server}`
  const files = {
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: {
        'acme-sobjects': { type: 'http', url: url('sobject-all'), oauth: { clientId: 'acme-key' } },
        'acme-metadata': { type: 'http', url: url('metadata-experts'), oauth: { clientId: 'acme-key' } },
        'globex-sobjects': { type: 'http', url: url('sobject-all'), oauth: { clientId: 'globex-key' } },
      },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // One line per org: both acme servers on one, globex on its own
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ acme-metadata, ✗ acme-sobjects$/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ globex-sobjects$/ })).toBeDefined()
})

test('a CLI org and a hosted MCP server show side by side', async ($, on) => {
  const files = {
    ...FILES,
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: { sf: { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-all' } },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'sf' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'sf › mcp › ' })).toBeDefined()
})

test('a DX MCP Server line lists the aliases it allows, with their types', async ($, on) => {
  const files = {
    ...FILES,
    [`${HOME}/.sfdx/alias.json`]: { orgs: { 'my-scratch': 'test-1@example.com', uat: 'me@acme.com.uat' } },
    [`${HOME}/.sfdx/me@acme.com.uat.json`]: { isSandbox: true },
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: { 'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG,uat'] } },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'sf › cli › ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'my-scratch, uat' })).toBeDefined()
    // A pill per org it reaches
    expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ salesforce-dx › my-scratch, uat › speedy-1-dev-ed ›  scratch  sandbox $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' sandbox ' })).toMatchObject({ props: { backgroundColor: 'warning' } })
    await ui.unmount()
  }
})

test('a DX MCP Server with ALLOW_ALL_ORGS gets a red all-orgs pill', async ($, on) => {
  const files = {
    [`${HOME}/.claude.json`]: {
      mcpServers: { dx: { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'ALLOW_ALL_ORGS'] } },
    },
  }
  const clock = stubSession(on, '/work/plain', files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'every org the CLI knows' })).toBeDefined()
  const pillColor = async () => (await ui.find({ type: 'Text', text: ' all orgs ' }))?.props?.backgroundColor
  expect(await pillColor()).toBe('error')
  await clock.advance(600)
  expect(await pillColor()).toBe('error')
})

test("a scratch org's name holds its color", async ($, on) => {
  const clock = stubSession(on, PROJECT)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await clock.advance(600)
  expect(await ui.find({ type: 'Text', text: /^my-scratch$/ })).toMatchObject({ props: { color: 'success' } })
})

test('the band and sf-headless-config agree: connected servers, developer edition and SF_TARGET_ORG', async ($, on) => {
  const files = {
    [`${PROJECT}/sfdx-project.json`]: {},
    [`${PROJECT}/.sf/config.json`]: { 'target-org': 'my-scratch' },
    [`${HOME}/.sfdx/alias.json`]: { orgs: { 'my-scratch': 'test-1@example.com', dev: 'me@acme-dev.com' } },
    [`${HOME}/.sfdx/test-1@example.com.json`]: { isScratch: true, expirationDate: '2026-10-08' },
    [`${HOME}/.sfdx/me@acme-dev.com.json`]: { instanceUrl: 'https://acme-dev-ed.develop.my.salesforce.com' },
    [`${HOME}/.claude.json`]: {
      mcpServers: {
        'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG'] },
        'sobject-all': { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all' },
      },
      // Disabled for the project: not in use, so not in the band
      projects: { [PROJECT]: { disabledMcpServers: ['sobject-all'] } },
    },
  }
  stubSession(on, PROJECT, files, { SF_TARGET_ORG: 'dev' })
  on('session.usage', () => ({
    value: { context: { window: 200_000, breakdown: { mcpTools: [{ name: 'mcp__salesforce-dx__list_all_orgs', serverName: 'salesforce-dx', tokens: 100, isLoaded: true }] } } },
  }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // SF_TARGET_ORG wins over the project's target-org, as the CLI has it
    expect(await ui.find({ type: 'Box', text: /^sf › cli › default org: dev › acme-dev-ed$/ })).toBeDefined()
    expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✓ salesforce-dx › dev › acme-dev-ed ›  developer edition $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' developer edition ' })).toMatchObject({ props: { backgroundColor: 'suggestion' } })
    expect(await ui.find({ type: 'Text', text: 'sobject-all' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a default org changed in another session shows within a few seconds, as in sf-headless-config', async ($, on) => {
  const files: Record<string, unknown> = { ...FILES, [`${HOME}/.sfdx/me@acme.com.json`]: { instanceUrl: 'https://acme.my.salesforce.com' } }
  const mtimes: Record<string, number> = {}
  const clock = stubSession(on, PROJECT, files)
  on('fs.stat', ($, e) =>
    posix(e.path) in files
      ? { value: { kind: 'file', size: JSON.stringify(files[posix(e.path)]).length, mtimeMs: mtimes[posix(e.path)] ?? 1, isLink: false } }
      : { deny: 'ENOENT' },
  )
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()

  // `sf config set target-org me@acme.com` in another terminal
  files[`${PROJECT}/.sf/config.json`] = { 'target-org': 'me@acme.com' }
  mtimes[`${PROJECT}/.sf/config.json`] = 2
  await clock.advance(3000)

  expect(await ui.find({ type: 'Text', text: /^me@acme\.com$/ })).toMatchObject({ props: { color: 'claude' } })
  await ui.unmount()
})

test('each band line draws as one row: nothing in it stacks', async ($, on) => {
  const files = {
    ...FILES,
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: {
        'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG'] },
        a: { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all', oauth: { clientId: 'k' } },
        b: { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads', oauth: { clientId: 'k' } },
      },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    // The lines: the column of the band's own Box; in each, every Box lays its children in a row
    const lines = (await ui.findAll({ type: 'Box' })).filter(b => /^(sf|dx-|mcp-)/.test(b.key ?? ''))
    expect(lines.map(l => l.key)).toEqual(['sf', 'dx-salesforce-dx', 'mcp-production|k'])
    const stacked = (node: any): boolean =>
      node?.type === 'Fragment' ||
      (node?.type === 'Box' && node.props?.flexDirection !== undefined && node.props.flexDirection !== 'row') ||
      (Array.isArray(node?.children) && node.children.some(stacked))
    for (const line of lines) {
      expect(line.props.flexDirection).toBe('row')
      expect(line.children.some(stacked)).toBe(false)
    }
    await ui.unmount()
  }
})

test('the band starts off until /sf-headless-band turns it on', async ($, on) => {
  stubSession(on, PROJECT, FILES, {}, {})
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()

  expect((await $.command.run({ command: 'sf-headless-band', args: '' } as never) as { text: string }).text).toMatch(/shown/)
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
  await ui.unmount()
})

test('/sf-headless-band hides and shows the band, and the choice is kept', async ($, on) => {
  stubSession(on, PROJECT)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()

  expect((await $.command.run({ command: 'sf-headless-band', args: '' } as never) as { text: string }).text).toMatch(/hidden/)
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeUndefined()
  // Other mods' band content stays
  expect(await ui.find({ type: 'Text', text: 'another mod' })).toBeDefined()

  // A new session keeps it hidden
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeUndefined()

  expect((await $.command.run({ command: 'sf-headless-band', args: 'on' } as never) as { text: string }).text).toMatch(/shown/)
  expect(await ui.find({ type: 'Text', text: 'my-scratch' })).toBeDefined()
  await ui.unmount()
})

test("a hosted server's calls carry its My Domain: the band names the org and its exact type, as the pane does", async ($, on) => {
  const files = {
    [`${HOME}/.claude.json`]: {
      mcpServers: { 'sf-headless-toolkit': { type: 'http', url: 'https://api.salesforce.com/platform/mcp/v1/platform/headless-360', oauth: { clientId: 'k' } } },
    },
  }
  stubSession(on, '/work/plain', files)
  let answer = 'ok'
  on('tool.call', () => ({ result: 'x', text: answer }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Before any call: no type claimed
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ sf-headless-toolkit$/ })).toBeDefined()

  // The URL a dispatch is given names the org
  await $.tool.call({ tool: 'mcp__sf-headless-toolkit__dispatch_readonly', url: 'https://headless-360-0826.my.salesforce.com/services/data/v66.0/tooling/query' } as never)
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ sf-headless-toolkit › headless-360-0826 ›  production $/ })).toBeDefined()

  // A developer edition's result makes the type exact
  answer = '{"url":"https://acme-dev-ed.develop.my.salesforce.com/services/data"}'
  await $.tool.call({ tool: 'mcp__sf-headless-toolkit__dispatch_readonly' } as never)
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ sf-headless-toolkit › acme-dev-ed ›  developer edition $/ })).toBeDefined()
  await ui.unmount()
})

test('outside a Salesforce project the global default org still shows, as a DX server resolves it', async ($, on) => {
  const files = {
    [`${HOME}/.sf/config.json`]: { 'target-org': 'uat-testing' },
    [`${HOME}/.sfdx/alias.json`]: { orgs: { 'uat-testing': 'demo@coworker-df26.com.dev' } },
    [`${HOME}/.sfdx/demo@coworker-df26.com.dev.json`]: { isSandbox: true, instanceUrl: 'https://coworker-df26--dev.sandbox.my.salesforce.com' },
    [`${HOME}/.claude.json`]: {
      mcpServers: { 'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG'] } },
    },
  }
  stubSession(on, '/work/plain', files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', text: /^sf › cli › default org: uat-testing › coworker-df26--dev$/ })).toBeDefined()
  expect(await ui.find({ type: 'Box', text: /^sf › mcp › ✗ salesforce-dx › uat-testing › coworker-df26--dev ›  sandbox $/ })).toBeDefined()
  await ui.unmount()
})

// The mod's settings as a team that shares a QA sandbox and gates its pull requests would set them
const OPTIONS = {
  sharedSandboxes: ['acme--partial'],
  sharedSandboxLabel: 'shared QA sandbox',
  gates: ['review-gate=awaiting review', 'qa-gate=QA open', 'flow-review-gate=flow review needed'],
}

// This fork's own: a labeled CLI line, a project-set org marked, a login not your own named,
// and the shared QA sandbox in its own color
const SANDBOXES: Record<string, unknown> = {
  [`${PROJECT}/sfdx-project.json`]: {},
  [`${HOME}/.claude.json`]: { oauthAccount: { emailAddress: 'Me@acme.com' } },
  [`${HOME}/.sf/config.json`]: { 'target-org': 'mine' },
  [`${HOME}/.sfdx/alias.json`]: {
    orgs: { mine: 'me@acme.com.mine', partial: 'me@acme.com.partial', 'devops-partial': 'devops@acme.com.partial' },
  },
  [`${HOME}/.sfdx/me@acme.com.mine.json`]: { isSandbox: true, instanceUrl: 'https://acme--mine.sandbox.my.salesforce.com' },
  [`${HOME}/.sfdx/me@acme.com.partial.json`]: { isSandbox: true, instanceUrl: 'https://acme--partial.sandbox.my.salesforce.com' },
  [`${HOME}/.sfdx/devops@acme.com.partial.json`]: { isSandbox: true, instanceUrl: 'https://acme--partial.sandbox.my.salesforce.com' },
}

test('your own sandbox shows as just its alias, in green: no prefix, no repeated My Domain, no login, no local marker', async ($, on) => {
  stubSession(on, PROJECT, SANDBOXES)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^mine$/ })).toMatchObject({ props: { bold: true, color: 'success' } })
    expect(await ui.find({ type: 'Text', text: 'local config' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^as / })).toBeUndefined()
    await ui.unmount()
  }
})

test("another login names itself, and its My Domain shows when it doesn't repeat the alias", async ($, on) => {
  stubSession(on, PROJECT, { ...SANDBOXES, [`${HOME}/.sf/config.json`]: { 'target-org': 'devops-partial' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Box', text: /^default org: devops-partial › acme--partial › as devops@$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'as devops@' })).toMatchObject({ props: { bold: true, color: 'warning' } })
    await ui.unmount()
  }
})

test('the sf › cli prefix comes back beside an MCP line', async ($, on) => {
  const files = {
    ...SANDBOXES,
    [`${PROJECT}/.mcp.json`]: {
      mcpServers: { 'salesforce-dx': { command: 'npx', args: ['-y', '@salesforce/mcp', '--orgs', 'DEFAULT_TARGET_ORG'] } },
    },
  }
  stubSession(on, PROJECT, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', text: /^sf › cli › default org: mine$/ })).toBeDefined()
  await ui.unmount()
})

test("the project's own config pinning partial shows the local marker and partial in yellow", { options: OPTIONS }, async ($, on) => {
  stubSession(on, PROJECT, { ...SANDBOXES, [`${PROJECT}/.sfdx/sfdx-config.json`]: { defaultusername: 'partial' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Box', text: /^default org: partial › local config$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'local config' })).toMatchObject({ props: { color: 'warning' } })
    // The shared QA sandbox's name in yellow, where your own sandbox's is green
    expect(await ui.find({ type: 'Text', text: /^partial$/ })).toMatchObject({ props: { bold: true, color: 'warning' } })
    expect(await ui.find({ type: 'Text', text: /sandbox/ })).toBeUndefined()
    await ui.unmount()
  }
})

test("the context window's fill ends the line, its percentage green, then yellow from 30% and orange from 40%, as each response reports it", async ($, on) => {
  stubSession(on, PROJECT, SANDBOXES)
  on('session.usage', () => ({ value: { context: { window: 1_000_000, tokens: 316_512, percent: 32 } } }) as never)
  // The engine's own answer beneath the plugins: it echoes what changed
  on('session.measure', ($, e) => ({ changed: e.changed }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Box', text: /^default org: mine · context used: 32%$/ })).toBeDefined()
    // The label dim, the percentage alone in its color
    expect(await ui.find({ type: 'Text', text: /^ · context used: $/ })).toMatchObject({ props: { dimColor: true } })
    expect(await ui.find({ type: 'Text', text: /^32%$/ })).toMatchObject({ props: { bold: true, color: 'warning' } })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.session.measure({ context: { window: 1_000_000, tokens: 290_000, percent: 29 }, rateLimits: [], changed: ['context'] })
  expect(await ui.find({ type: 'Text', text: /^29%$/ })).toMatchObject({ props: { bold: true, color: 'success' } })
  await $.session.measure({ context: { window: 1_000_000, tokens: 400_000, percent: 40 }, rateLimits: [], changed: ['context'] })
  expect(await ui.find({ type: 'Text', text: /^40%$/ })).toMatchObject({ props: { bold: true, color: 'claude' } })
  await ui.unmount()
})

test('before any response reports a fill, the line shows no context figure', async ($, on) => {
  stubSession(on, PROJECT, SANDBOXES)
  on('session.usage', () => ({ value: { context: { window: 1_000_000 } } }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /context/ })).toBeUndefined()
  await ui.unmount()
})

// This fork's own: the pull request for the session folder's branch, read with git and gh.
// `answers.view` is what `gh pr view` prints for the branch, and `answers.byRef` what it prints
// for a pull request named by number or URL; undefined is gh's exit 1 for one with none.
// `answers.calls`, when given, collects each command line run
const stubPr = (
  on: Parameters<TestBody>[1],
  answers: { branch?: string; view?: unknown; byRef?: Record<string, unknown>; calls?: string[] },
) => {
  const asked: string[] = []
  const ran = (exitCode: number, stdout: string) => ({
    value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'no pull requests found', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('process.run', ($, e) => {
    asked.push(e.argv[0]!)
    answers.calls?.push(e.argv.slice(0, e.argv.indexOf('--json') === -1 ? undefined : e.argv.indexOf('--json')).join(' '))
    if (e.argv[0] === 'git') return answers.branch === undefined ? ran(128, '') : ran(0, `${answers.branch}\n`)
    if (e.argv[0] === 'gh') {
      // `gh pr view <number or URL> --json …` names its pull request; with no name gh reads the branch's
      const ref = e.argv[3] === '--json' ? undefined : e.argv[3]
      const view = ref === undefined ? answers.view : answers.byRef?.[ref]
      return view === undefined ? ran(1, '') : ran(0, JSON.stringify(view))
    }
    return ran(1, '')
  })
  return asked
}

const OPEN_PR = {
  number: 1677,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  latestReviews: [],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'validate', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'analyze', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'qa-gate', state: 'FAILURE' },
    { __typename: 'StatusContext', context: 'review-gate', state: 'FAILURE' },
  ],
}

const READY_PR = {
  ...OPEN_PR,
  latestReviews: [{ state: 'APPROVED' }],
  statusCheckRollup: OPEN_PR.statusCheckRollup.map(c => ('conclusion' in c ? { ...c, conclusion: 'SUCCESS' } : { ...c, state: 'SUCCESS' })),
}

test("the branch's pull request gets a line: its state, each gate not passed, and the failing checks", { options: OPTIONS }, async ($, on) => {
  const clock = stubSession(on, PROJECT, SANDBOXES)
  stubPr(on, { branch: 'feature/mcp-token-exchange', view: OPEN_PR })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  // The read runs from a timer of its own, so the mocked clock lets it go
  await clock.advance(0)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()
    expect(await ui.find({ type: 'Box', text: /^pr › #1677 › open › awaiting review › QA open › ✗ validate$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'awaiting review' })).toMatchObject({ props: { color: 'warning' } })
    expect(await ui.find({ type: 'Text', text: '✗ validate' })).toMatchObject({ props: { bold: true, color: 'error' } })
    await ui.unmount()
  }
})

test('a branch with no pull request, or a folder with no branch, has no PR line', async ($, on) => {
  const clock = stubSession(on, PROJECT, SANDBOXES)
  const asked = stubPr(on, { branch: 'develop' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  // The read runs from a timer of its own, so the mocked clock lets it go
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^pr › / })).toBeUndefined()
  expect(asked).toEqual(['git', 'gh'])
  await ui.unmount()
})

test('outside a Salesforce project, with no org, the PR line shows alone', async ($, on) => {
  const clock = stubSession(on, '/work/plain', {})
  stubPr(on, { branch: 'docs/example-change', view: { ...READY_PR, number: 13, state: 'MERGED' } })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work/plain' })
  // The read runs from a timer of its own, so the mocked clock lets it go
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // Once merged, its reviews and checks are left off
  expect(await ui.find({ type: 'Box', text: /^pr › #13 › merged$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'merged' })).toMatchObject({ props: { color: 'success' } })
  await ui.unmount()
})

test('a command that opens a pull request shows it at once; an open one is read again every two minutes', { options: OPTIONS }, async ($, on) => {
  const clock = stubSession(on, PROJECT, SANDBOXES)
  const answers: { branch?: string; view?: unknown } = { branch: 'feature/mcp-token-exchange' }
  stubPr(on, answers)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, gitOperation: { pr: { number: 1677, action: 'created' } } }, text: '' }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  // The read runs from a timer of its own, so the mocked clock lets it go
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^pr › / })).toBeUndefined()

  answers.view = OPEN_PR
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
  await clock.advance(0)
  expect(await ui.find({ type: 'Box', text: /^pr › #1677 › open › awaiting review › QA open › ✗ validate$/ })).toBeDefined()

  // Approved, QA done and every check green, with nothing local to show it: the timer reads it
  answers.view = READY_PR
  await clock.advance(120_000)
  expect(await ui.find({ type: 'Box', text: /^pr › #1677 › open › approved › checks ✓$/ })).toBeDefined()
  await ui.unmount()
})

const PR_URL = 'https://github.com/acme/app/pull/1692'

// A shell command's answer naming the pull request it opened, as the tool's record carries it
const stubOpened = (on: Parameters<TestBody>[1]) =>
  on('tool.call', () => ({ result: { stdout: PR_URL, stderr: '', interrupted: false, gitOperation: { pr: { number: 1692, url: PR_URL, action: 'created' } } }, text: PR_URL }) as never)

test("a session in the root checkout, on develop, shows the pull request its own command opened from a worktree's branch", async ($, on) => {
  const clock = stubSession(on, PROJECT, SANDBOXES)
  const calls: string[] = []
  stubPr(on, { branch: 'develop', byRef: { [PR_URL]: { ...READY_PR, number: 1692 } }, calls })
  stubOpened(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  // The read runs from a timer of its own, so the mocked clock lets it go
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^pr › / })).toBeUndefined()

  await $.tool.call({ tool: 'PowerShell', command: 'gh pr create --base develop --head chore/handoff-skill-starts-child-session --fill' } as never)
  await clock.advance(0)
  expect(await ui.find({ type: 'Box', text: /^pr › #1692 › open › approved › checks ✓$/ })).toBeDefined()
  // The branch is asked first and has none; the session's own is then read by its URL
  expect(calls.slice(-3)).toEqual(['git rev-parse --abbrev-ref HEAD', 'gh pr view', `gh pr view ${PR_URL}`])
  await ui.unmount()
})

test("a folder whose branch has a pull request keeps showing it over the session's own", { options: OPTIONS }, async ($, on) => {
  const clock = stubSession(on, PROJECT, SANDBOXES)
  const calls: string[] = []
  stubPr(on, { branch: 'feature/mcp-token-exchange', view: OPEN_PR, byRef: { [PR_URL]: { ...READY_PR, number: 1692 } }, calls })
  stubOpened(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --head chore/other --fill' } as never)
  await clock.advance(0)
  expect(await ui.find({ type: 'Box', text: /^pr › #1677 › open › awaiting review › QA open › ✗ validate$/ })).toBeDefined()
  expect(calls).not.toContain(`gh pr view ${PR_URL}`)
  await ui.unmount()
})

test("a resumed session reads its own pull request back from the transcript, in the one read the last sf target shares", { options: OPTIONS }, async ($, on) => {
  const clock = stubSession(on, PROJECT, SANDBOXES)
  stubPr(on, { branch: 'develop', byRef: { [PR_URL]: { ...OPEN_PR, number: 1692 } } })
  let reads = 0
  on('session.messages', () => {
    reads++
    return {
      value: [
        {
          role: 'assistant',
          text: '',
          toolUses: [{ tool_use_id: 'toolu_0', tool: 'Bash', input: { command: 'gh pr create --fill' }, text: PR_URL, result: { stdout: PR_URL, stderr: '', interrupted: false, gitOperation: { pr: { number: 1692, url: PR_URL, action: 'created' } } } }],
        },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'git status --short' }, text: '', result: { stdout: '', stderr: '', interrupted: false } }] },
      ],
    } as never
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  await clock.advance(0)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', text: /^pr › #1692 › open › awaiting review › QA open › ✗ validate$/ })).toBeDefined()
  await clock.advance(30_000)
  expect(reads).toBe(1)
  await ui.unmount()
})

// This fork's own: where the last sf command went, when that wasn't the default org
const WITH_PROD: Record<string, unknown> = {
  ...SANDBOXES,
  [`${HOME}/.sfdx/alias.json`]: {
    orgs: { mine: 'me@acme.com.mine', partial: 'me@acme.com.partial', prod: 'me@acme.com' },
  },
  [`${HOME}/.sfdx/me@acme.com.json`]: { instanceUrl: 'https://acme.my.salesforce.com' },
}

// The shell's own answer beneath the plugins, for any command
const stubShell = (on: Parameters<TestBody>[1]) =>
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }) as never)

test('an sf command naming another org shows on the CLI line until one runs on the default', async ($, on) => {
  stubSession(on, PROJECT, WITH_PROD)
  stubShell(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  await $.tool.call({ tool: 'Bash', command: 'sf data query -q "SELECT Id FROM User" -o prod --json' } as never)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Box', text: /^default org: mine · last target: prod$/ })).toBeDefined()
    // Anchored: a plain string also matches a Text that merely contains it. Production in orange
    expect(await ui.find({ type: 'Text', text: /^prod$/ })).toMatchObject({ props: { bold: true, color: 'claude' } })
    expect(await ui.find({ type: 'Text', text: /production/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // A command that reaches no org through sf leaves it standing
  await $.tool.call({ tool: 'Bash', command: 'git status --short' } as never)
  await $.tool.call({ tool: 'Bash', command: 'sf config get target-org --json' } as never)
  expect(await ui.find({ type: 'Box', text: /^default org: mine · last target: prod$/ })).toBeDefined()
  // One on the default org takes it off
  await $.tool.call({ tool: 'Bash', command: 'sf project deploy start -d force-app' } as never)
  expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /last target/ })).toBeUndefined()
  await ui.unmount()
})

test("a hook's refusal read from the result counts as refused", async ($, on) => {
  stubSession(on, PROJECT, WITH_PROD)
  // The mod hooks no classic.PreToolUse: the refusal shows only in the errored result's text
  const failed = (text: string) => ({ isError: true, result: text, text }) as never
  on('tool.call', ($, e) => {
    const command = String((e as { command?: unknown }).command)
    if (command.includes('-o partial')) return failed('PreToolUse:Bash hook error: Skills-first enforcement: dispatch the platform-soql-query skill instead')
    if (command.includes('sf org display')) return failed('<tool_use_error>PreToolUse:PowerShell hook error: refused</tool_use_error>')
    // An ordinary failure after sf ran still counts
    if (command.includes('-o prod')) return failed('Exit code 1\nINVALID_FIELD: No such column')
    return { result: { stdout: '', stderr: '', interrupted: false }, text: '' } as never
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.tool.call({ tool: 'Bash', command: 'sf data query -q "SELECT Bad FROM User" -o prod --json' } as never)
  expect(await ui.find({ type: 'Box', text: /^default org: mine · last target: prod$/ })).toBeDefined()

  await $.tool.call({ tool: 'Bash', command: 'sf data query -q "SELECT Id FROM Organization" -o partial --json' } as never)
  await $.tool.call({ tool: 'PowerShell', command: 'sf org display --json' } as never)
  expect(await ui.find({ type: 'Box', text: /^default org: mine · last target: prod$/ })).toBeDefined()

  // A refusal worded for another tool is not this call's
  await $.tool.call({ tool: 'Bash', command: 'sf org display --json' } as never)
  expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()
  await ui.unmount()
})

test("the line keeps both labels whatever the band's width, and none of its parts shrinks", { options: OPTIONS }, async ($, on) => {
  stubSession(on, PROJECT, WITH_PROD)
  stubShell(on)
  on('session.usage', () => ({ value: { context: { window: 1_000_000, tokens: 160_000, percent: 16 } } }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })
  await $.tool.call({ tool: 'Bash', command: 'sf data query -q "SELECT Id FROM Organization" -o partial --json' } as never)

  // The whole line takes 61 cells: with room, and well short of it
  const narrow = (bodyColumns: number) => ({ ...BAND, props: { ...BAND.props, bodyColumns } })
  for (const surface of SURFACES) {
    for (const columns of [95, 40]) {
      const ui = await $.ui.mount({ ...narrow(columns), surface })
      expect(await ui.find({ type: 'Box', text: /^default org: mine · last target: partial · context used: 16%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^mine$/ })).toMatchObject({ props: { bold: true, color: 'success' } })
      expect(await ui.find({ type: 'Text', text: /^partial$/ })).toMatchObject({ props: { bold: true, color: 'warning' } })
      await ui.unmount()
    }

    const ui = await $.ui.mount({ ...narrow(40), surface })
    // Plain Texts only, none holding another: the desktop wrapped, then emptied, a Text that did. And
    // nothing shrinks, so a line too long for the band runs past its edge rather than squeezing a label
    const line = (await ui.findAll({ type: 'Box' })).find(b => b.key === 'sf')!
    const parts = (line.children as ({ type?: string; props?: Record<string, unknown>; children?: unknown[] } | null)[]).filter(p => p !== null && typeof p === 'object') as { type?: string; props?: Record<string, unknown>; children?: unknown[] }[]
    expect(parts.every(p => p.type === 'Box' && p.props?.flexShrink === 0)).toBe(true)
    const [marker, context] = parts.slice(-2)
    expect(marker).toMatchObject({ type: 'Box', props: { flexDirection: 'row', flexShrink: 0 } })
    expect(marker!.children!.every((c: any) => c.type === 'Text' && c.children.every((t: unknown) => typeof t === 'string'))).toBe(true)
    expect(context).toMatchObject({
      type: 'Box',
      props: { flexShrink: 0 },
      children: [
        { type: 'Text', props: { dimColor: true } },
        { type: 'Text', props: { bold: true, color: 'success' } },
      ],
    })
    await ui.unmount()
  }
})

test('naming the default org shows nothing; a command reaching several shows each, riskiest first, from PowerShell too', { options: OPTIONS }, async ($, on) => {
  stubSession(on, PROJECT, WITH_PROD)
  stubShell(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.tool.call({ tool: 'Bash', command: 'sf org display -o mine --json' } as never)
  expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()

  await $.tool.call({ tool: 'PowerShell', command: `sf data query -q "x" -o partial; sf data query -q "x" -o prod` } as never)
  expect(await ui.find({ type: 'Box', text: /^default org: mine · last target: prod partial$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^prod$/ })).toMatchObject({ props: { color: 'claude' } })
  expect(await ui.find({ type: 'Text', text: /^partial$/ })).toMatchObject({ props: { color: 'warning' } })
  await ui.unmount()
})

// A transcript as `$.session.messages()` answers it, one assistant message per call
const transcript = (...calls: { command: string; text?: string; isError?: true }[]) =>
  calls.map((c, i) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: `toolu_${i}`, tool: 'Bash', input: { command: c.command }, text: c.text ?? '', ...(c.isError ? { isError: c.isError } : {}) }] }))

test('a resumed session starts with empty state, so the marker is read back from its transcript', async ($, on) => {
  const clock = stubSession(on, PROJECT, WITH_PROD)
  stubShell(on)
  let reads = 0
  on('session.messages', () => {
    reads++
    return {
      value: transcript(
        { command: 'sf data query -q "SELECT Id FROM User" -o prod --json' },
        { command: 'git status --short' },
        { command: 'sf data query -q "x" -o partial --json', text: 'PreToolUse:Bash hook error: Skills-first enforcement', isError: true },
      ),
    } as never
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Box', text: /^default org: mine · last target: prod$/ })).toBeDefined()
    await ui.unmount()
  }

  // Read once: the refreshes that follow find the marker set
  await clock.advance(30_000)
  expect(reads).toBe(1)

  // A command that ran after the resume moves it as before, and an empty marker is not read again
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.tool.call({ tool: 'Bash', command: 'sf project deploy start -d force-app' } as never)
  expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()
  await clock.advance(30_000)
  expect(reads).toBe(1)
  await ui.unmount()
})

test('a transcript with no sf command shows no marker, and is read once', async ($, on) => {
  const clock = stubSession(on, PROJECT, WITH_PROD)
  let reads = 0
  on('session.messages', () => {
    reads++
    return { value: transcript({ command: 'git status --short' }) } as never
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: PROJECT })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Box', text: /^default org: mine$/ })).toBeDefined()
  await clock.advance(30_000)
  expect(reads).toBe(1)
  await ui.unmount()
})
