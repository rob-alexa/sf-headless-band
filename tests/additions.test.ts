import { expect, test } from 'claude-code/testing'

import { contextColor, contextPercent, looksFrom, nameColor, orgLabel, otherLogin, repeatsAlias } from '../hooks/additions'

const LOOKS = looksFrom({ sharedSandboxes: ['acme--partial'], sharedSandboxLabel: 'shared QA sandbox' })
const NONE = looksFrom({})

test('the settings read into looks: names lowercased, a default label, gates by status, malformed gates dropped', () => {
  const looks = looksFrom({ sharedSandboxes: [' Acme--UAT ', ''], gates: ['qa-gate=QA open', 'review-gate = awaiting review', 'no-words=', '=no-status', 'bare'] })
  expect([...looks.shared]).toEqual(['acme--uat'])
  expect(looks.sharedLabel).toBe('shared sandbox')
  expect(looks.gates).toEqual({ 'qa-gate': 'QA open', 'review-gate': 'awaiting review' })
  // A plain string is read as comma-separated
  expect([...looksFrom({ sharedSandboxes: 'acme--uat, acme--qa' }).shared]).toEqual(['acme--uat', 'acme--qa'])
  expect(NONE).toEqual({ shared: new Set(), sharedLabel: 'shared sandbox', gates: {}, sfWrappers: [] })
  expect(looksFrom({ sfWrappers: [' sfw ', ''] }).sfWrappers).toEqual(['sfw'])
})

test('a shared sandbox has its own label; other orgs keep their type', () => {
  expect(orgLabel('sandbox', 'acme--partial.sandbox.my.salesforce.com', LOOKS)).toEqual({ label: 'shared QA sandbox', color: 'warning' })
  expect(orgLabel('sandbox', 'ACME--partial.sandbox.my.salesforce.com', LOOKS)).toEqual({ label: 'shared QA sandbox', color: 'warning' })
  expect(orgLabel('sandbox', 'acme--dev.sandbox.my.salesforce.com', LOOKS)).toBeUndefined()
  expect(orgLabel('sandbox', undefined, LOOKS)).toBeUndefined()
  // With no shared sandboxes set, none is labeled
  expect(orgLabel('sandbox', 'acme--partial.sandbox.my.salesforce.com', NONE)).toBeUndefined()
})

test('a production org never takes a label', () => {
  expect(orgLabel('production', 'acme--partial.sandbox.my.salesforce.com', LOOKS)).toBeUndefined()
})

test("an org's name is orange for production, yellow for a shared sandbox, green for any other sandbox", () => {
  expect(nameColor('production', 'acme.my.salesforce.com', LOOKS)).toBe('claude')
  expect(nameColor('production', 'acme--partial.sandbox.my.salesforce.com', LOOKS)).toBe('claude')
  expect(nameColor('sandbox', 'acme--partial.sandbox.my.salesforce.com', LOOKS)).toBe('warning')
  expect(nameColor('sandbox', 'acme--partial.sandbox.my.salesforce.com', NONE)).toBe('success')
  expect(nameColor('sandbox', 'acme--dev.sandbox.my.salesforce.com', LOOKS)).toBe('success')
  expect(nameColor('sandbox', undefined, LOOKS)).toBe('success')
  // The other types keep their own colors
  expect([nameColor('scratch', undefined, LOOKS), nameColor('developer', undefined, LOOKS), nameColor('unknown', undefined, LOOKS)]).toEqual(['success', 'suggestion', 'inactive'])
})

test('a My Domain only repeats the alias when it is the alias or ends in --alias', () => {
  expect(repeatsAlias('dev', 'acme--dev.sandbox.my.salesforce.com')).toBe(true)
  expect(repeatsAlias('Dev', 'ACme--dev.sandbox.my.salesforce.com')).toBe(true)
  expect(repeatsAlias('devops-partial', 'acme--partial.sandbox.my.salesforce.com')).toBe(false)
  expect(repeatsAlias('prod', 'acme.my.salesforce.com')).toBe(false)
})

test("a login is named only when it is neither the account's own email nor a sandbox copy of it", () => {
  expect(otherLogin('me@acme.com', 'Me@acme.com')).toBeUndefined()
  expect(otherLogin('me@acme.com.dev', 'me@acme.com')).toBeUndefined()
  expect(otherLogin('devops@acme.com.partial', 'me@acme.com')).toBe('devops@')
  expect(otherLogin('devops@acme.com', 'me@acme.com')).toBe('devops@')
  // A longer address that merely starts with the email is someone else
  expect(otherLogin('me@acme.community', 'me@acme.com')).toBe('me@')
  // No account known, or no username: nothing to judge
  expect(otherLogin('devops@acme.com', undefined)).toBeUndefined()
  expect(otherLogin('dev', 'me@acme.com')).toBeUndefined()
})

test('the context figure comes from the reported percentage, else tokens over window, else none', () => {
  expect(contextPercent({ window: 1_000_000, tokens: 316_512, percent: 32 })).toBe(32)
  expect(contextPercent({ window: 200_000, tokens: 50_000 })).toBe(25)
  expect(contextPercent({ window: 200_000 })).toBe(null)
  expect(contextPercent(undefined)).toBe(null)
  // Green below 30%, yellow from 30%, orange from 40%
  expect([0, 29, 30, 39, 40, 100].map(contextColor)).toEqual(['success', 'success', 'warning', 'warning', 'claude', 'claude'])
})
