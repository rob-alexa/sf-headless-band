import { expect, test } from 'claude-code/testing'

import { looksFrom } from '../hooks/additions'
import { failingText, lastSessionPr, prOf, prRefOf } from '../hooks/pr'

// The gates as a person would set them in the mod's settings
const GATES = looksFrom({ gates: ['review-gate=awaiting review', 'qa-gate=QA open', 'flow-review-gate=flow review needed'] }).gates

// Shaped as `gh pr view --json number,state,isDraft,mergeable,latestReviews,statusCheckRollup`
// answered for an open PR waiting on review and QA with validate red
const WAITING = {
  number: 1677,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  latestReviews: [],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'validate', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'analyze', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'CodeQL', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { __typename: 'StatusContext', context: 'qa-gate', state: 'FAILURE' },
    { __typename: 'StatusContext', context: 'review-gate', state: 'FAILURE' },
    { __typename: 'StatusContext', context: 'flow-review-gate', state: 'SUCCESS' },
  ],
}

test('gates not passed show by their words in the gates order, and stay out of the checks', () => {
  expect(prOf(JSON.stringify(WAITING), GATES)).toEqual({
    number: 1677,
    state: 'open',
    waiting: ['awaiting review', 'QA open'],
    failing: ['validate'],
    running: 0,
    // validate, analyze, gate and CodeQL by name; a neutral conclusion is not a failure
    passed: 3,
    conflicts: false,
  })
})

test('a check listed twice fails when either run failed, and a pending status counts as running', () => {
  const view = {
    ...WAITING,
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'validate', status: 'IN_PROGRESS' },
      { __typename: 'StatusContext', context: 'deploy-preview', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'qa-gate', state: 'PENDING' },
    ],
  }
  expect(prOf(JSON.stringify(view), GATES)).toMatchObject({ waiting: ['QA open'], failing: ['gate'], running: 2, passed: 0 })
})

test('changes requested outranks an approval; a draft, a merge, a close and a conflict each read as such', () => {
  const pr = (over: Record<string, unknown>) => prOf(JSON.stringify({ ...WAITING, ...over }), GATES)
  expect(pr({ latestReviews: [{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }] })?.review).toBe('changes requested')
  expect(pr({ latestReviews: [{ state: 'COMMENTED' }, { state: 'APPROVED' }] })?.review).toBe('approved')
  expect(pr({ latestReviews: [{ state: 'COMMENTED' }] })?.review).toBeUndefined()
  expect(pr({ isDraft: true })?.state).toBe('draft')
  expect(pr({ state: 'MERGED' })?.state).toBe('merged')
  expect(pr({ state: 'CLOSED', isDraft: true })?.state).toBe('closed')
  expect(pr({ mergeable: 'CONFLICTING' })?.conflicts).toBe(true)
  // Still being worked out is not a conflict
  expect(pr({ mergeable: 'UNKNOWN' })?.conflicts).toBe(false)
})

test('anything that is not a pull request reads as none', () => {
  expect(prOf('no pull requests found for branch "develop"', GATES)).toBe(null)
  expect(prOf('{}', GATES)).toBe(null)
  expect(prOf('null', GATES)).toBe(null)
})

const URL = 'https://github.com/acme/app/pull/1692'

test("a shell result names its pull request by gitOperation.pr, with the URL when it has one", () => {
  expect(prRefOf({ stdout: URL, gitOperation: { pr: { number: 1692, url: URL, action: 'created' } } })).toEqual({ number: 1692, url: URL })
  expect(prRefOf({ gitOperation: { pr: { number: 1692, action: 'merged' } } })).toEqual({ number: 1692 })
  expect(prRefOf({ gitOperation: { push: { branch: 'chore/x' } } })).toBeUndefined()
  expect(prRefOf('PreToolUse:Bash hook error: refused')).toBeUndefined()
  expect(prRefOf(undefined)).toBeUndefined()
})

test("the transcript's newest pull request named by a shell command is the session's own", () => {
  const use = (tool: string, result?: unknown) => ({ tool, ...(result === undefined ? {} : { result }) })
  const named = (number: number, url?: string) => ({ gitOperation: { pr: { number, ...(url ? { url } : {}), action: 'created' } } })
  const messages = [
    { toolUses: [use('Bash', named(1690))] },
    { toolUses: [use('PowerShell', named(1692, URL)), use('Bash', { stdout: '' })] },
    // A tool that isn't a shell, and a call still in flight, name none
    { toolUses: [use('Read', named(1700)), use('Bash')] },
  ]
  expect(lastSessionPr(messages)).toEqual({ number: 1692, url: URL })
  expect(lastSessionPr([{ toolUses: [use('Bash', { stdout: '' })] }, { toolUses: [] }])).toBeUndefined()
})

test('failing checks are named up to two, then counted', () => {
  expect(failingText(['validate'])).toBe('✗ validate')
  expect(failingText(['validate', 'analyze'])).toBe('✗ validate, analyze')
  expect(failingText(['validate', 'analyze', 'doc-links', 'shell-tests'])).toBe('✗ validate, analyze +2')
})
