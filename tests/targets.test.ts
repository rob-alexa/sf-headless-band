import { expect, test } from 'claude-code/testing'

import { lastSfCommand, sfTargets } from '../hooks/targets'

test('an sf command names its org by -o or --target-org, a pipe included', () => {
  expect(sfTargets(`sf data query -q "SELECT Id FROM Account" -o prod --json`)).toEqual(['prod'])
  expect(sfTargets(`sf data query -q "SELECT Id FROM User" --target-org=partial | jq -r '.result.records[]'`)).toEqual(['partial'])
  expect(sfTargets('cd force-app && sf project deploy start -o mine')).toEqual(['mine'])
  expect(sfTargets('sf data query -q "x" -u legacy@acme.com')).toEqual(['legacy@acme.com'])
})

test('a wrapper named in the settings is read as sf is; without the setting it is not sf', () => {
  const query = `sfw data query -q "SELECT Id FROM User" --target-org=partial | jq -r '.result.records[]'`
  expect(sfTargets(query, ['sfw'])).toEqual(['partial'])
  expect(sfTargets('tools/SFW.cmd org display -o prod', ['sfw'])).toEqual(['prod'])
  expect(sfTargets(query)).toBeUndefined()
  // Inside a shell's -c command too, and in the transcript's last command
  expect(sfTargets(`bash -c "sfw org display -o uat"`, ['sfw'])).toEqual(['uat'])
  const messages = [{ toolUses: [{ tool: 'Bash', input: { command: query }, text: '' }] }]
  expect(lastSfCommand(messages, ['sfw'])).toBe(query)
  expect(lastSfCommand(messages)).toBeUndefined()
})

test('an sf command naming no org reaches the default; one that reaches no org leaves the last answer', () => {
  expect(sfTargets('sf project deploy start -d force-app/main/default/objects')).toEqual([])
  expect(sfTargets('sf config get target-org --json')).toBeUndefined()
  expect(sfTargets('sf alias list')).toBeUndefined()
  expect(sfTargets('sf project generate manifest -d force-app')).toBeUndefined()
  expect(sfTargets('sf org list --json')).toBeUndefined()
  expect(sfTargets('sf data query --help')).toBeUndefined()
  expect(sfTargets('git status --short')).toBeUndefined()
  // A named org always counts, a generator's too
  expect(sfTargets('sf org generate password -o prod')).toEqual(['prod'])
})

test('sf named in text, a message or a heredoc body is not a command', () => {
  expect(sfTargets(`git commit -m "use sf -o prod"`)).toBeUndefined()
  expect(sfTargets('echo sf data delete -o prod')).toBeUndefined()
  expect(sfTargets("git commit -F - <<'EOF'\nchore: sf data delete record -o prod\nEOF")).toBeUndefined()
  expect(sfTargets("Set-Content notes.txt @'\nsf data delete record -o prod\n'@")).toBeUndefined()
  // The heredoc's own line is still a command
  expect(sfTargets('cat <<EOF | sf data import tree -o mine --files -\n{}\nEOF')).toEqual(['mine'])
})

test('every org a command reaches is named, in a command substitution too', () => {
  expect(sfTargets(`ID=$(sf org display -o prod --json | jq -r .result.id); sf data query -q "x" -o partial`)).toEqual(['prod', 'partial'])
})

test('SF_TARGET_ORG set in the command names the org, as a prefix, an export or a PowerShell $env:', () => {
  expect(sfTargets('SF_TARGET_ORG=prod sf org display')).toEqual(['prod'])
  expect(sfTargets('export SF_TARGET_ORG=prod; sf org display')).toEqual(['prod'])
  expect(sfTargets(`$env:SF_TARGET_ORG = 'prod'; sf org display`)).toEqual(['prod'])
  // A prefix reaches only its own command
  expect(sfTargets('SF_TARGET_ORG=prod sf org display; sf org display')).toEqual(['prod'])
  // -o wins over the variable
  expect(sfTargets('SF_TARGET_ORG=prod sf org display -o mine')).toEqual(['mine'])
})

test('a .sh script names its org by --target-org or --org; one naming none is left alone', () => {
  expect(sfTargets(`scripts/delete-records.sh --target-org prod --sobject User --where "Id = '005x'"`)).toEqual(['prod'])
  expect(sfTargets('bash scripts/check-deploy.sh --org partial --dry-run')).toEqual(['partial'])
  expect(sfTargets('scripts/lint-docs.sh')).toBeUndefined()
})

test("a shell's -c command, a Windows path to sf and a variable are read as written", () => {
  expect(sfTargets(`bash -c "sf org display -o prod --json"`)).toEqual(['prod'])
  expect(sfTargets(`& 'C:\\Program Files\\sf\\bin\\sf.cmd' org display -o prod`)).toEqual(['prod'])
  expect(sfTargets(`sf data query -q "x" -o "$ORG"`)).toEqual(['$ORG'])
})

test("the transcript's last sf command is the newest that ran, passing over refused, unfinished and orgless calls", () => {
  const call = (tool: string, command: string, text = '', isError?: true) => ({ tool, input: { command }, text, ...(isError ? { isError } : {}) })
  const messages = [
    { toolUses: [call('Bash', 'sf data query -q "x" -o prod'), call('PowerShell', 'sf data query -q "x" -o partial')] },
    {
      toolUses: [
        call('Bash', 'sf data query -q "x" -o mine', 'PreToolUse:Bash hook error: refused', true),
        call('Read', 'sf data query -q "x" -o mine'),
        call('Bash', 'sf config get target-org'),
        // Still in flight: no text yet
        { tool: 'Bash', input: { command: 'sf org display -o mine' } },
      ],
    },
  ]
  expect(lastSfCommand(messages)).toBe('sf data query -q "x" -o partial')
  // An ordinary failure after sf ran still counts
  expect(lastSfCommand([{ toolUses: [call('Bash', 'sf data query -q "Bad" -o prod', 'INVALID_FIELD', true)] }])).toBe('sf data query -q "Bad" -o prod')
  expect(lastSfCommand([{ toolUses: [call('Bash', 'git status')] }, { toolUses: [] }])).toBeUndefined()
})
