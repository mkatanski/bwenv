import { expect, test } from 'bun:test'

import { hashValue } from '../src/state'
import { decideSync } from '../src/sync-plan'

const base = { local: null, vault: null, lastWrittenHash: null, force: false }

test('nothing in the vault is missing, whatever the file holds', () => {
  expect(decideSync({ ...base, local: 'x' })).toBe('missing')
  expect(decideSync({ ...base, local: 'x', force: true })).toBe('missing')
})

test('equal values are unchanged', () => {
  expect(decideSync({ ...base, local: 'v', vault: 'v' })).toBe('unchanged')
})

test('an absent key is written', () => {
  expect(decideSync({ ...base, vault: 'v' })).toBe('write')
})

test('force writes over a differing value', () => {
  expect(decideSync({ ...base, local: 'x', vault: 'v', force: true })).toBe(
    'write',
  )
})

test('a value bwenv wrote last time is replaced', () => {
  expect(
    decideSync({
      ...base,
      local: 'old',
      vault: 'new',
      lastWrittenHash: hashValue('old'),
    }),
  ).toBe('write')
})

test('a value changed by hand since the last write is a conflict', () => {
  expect(
    decideSync({
      ...base,
      local: 'hand',
      vault: 'new',
      lastWrittenHash: hashValue('old'),
    }),
  ).toBe('conflict')
})

test('a differing value with no record is a conflict', () => {
  expect(decideSync({ ...base, local: 'x', vault: 'v' })).toBe('conflict')
})
