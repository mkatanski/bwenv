import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  fileHoldsEnvironment,
  forgetKey,
  hashValue,
  loadState,
  recordValues,
  saveState,
  statePath,
  type State,
} from '../src/state'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bwenv-state-'))
}

test('loadState returns an empty state when the file is absent', () => {
  expect(loadState(join(tempDir(), 'state.json'))).toEqual({})
})

test('state stores hashes, never values', () => {
  const path = join(tempDir(), 'bwenv', 'state.json')
  const state: State = {}
  recordValues(state, '/p/.env', 'p', 'local', { A: 'sekret' })
  saveState(path, state)
  expect(readFileSync(path, 'utf8')).not.toContain('sekret')
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(loadState(path)['/p/.env']?.values.A).toBe(hashValue('sekret'))
})

test('recordValues merges hashes and sets the environment', () => {
  const state: State = {}
  recordValues(state, '/p/.env', 'p', 'local', { A: '1' })
  recordValues(state, '/p/.env', 'p', 'staging', { B: '2' })
  expect(state['/p/.env']).toEqual({
    project: 'p',
    environment: 'staging',
    values: { A: hashValue('1'), B: hashValue('2') },
  })
})

test('forgetKey drops one hash', () => {
  const state: State = {}
  recordValues(state, '/p/.env', 'p', 'local', { A: '1', B: '2' })
  forgetKey(state, '/p/.env', 'A')
  expect(Object.keys(state['/p/.env']?.values ?? {})).toEqual(['B'])
})

test('statePath honours XDG_STATE_HOME', () => {
  expect(statePath({ XDG_STATE_HOME: '/x' }, '/home/me')).toBe(
    '/x/bwenv/state.json',
  )
  expect(statePath({}, '/home/me')).toBe(
    '/home/me/.local/state/bwenv/state.json',
  )
})

test('fileHoldsEnvironment', () => {
  const state: State = {}
  expect(fileHoldsEnvironment(state, '/p/.env', 'local', 'local')).toBe(true)
  expect(fileHoldsEnvironment(state, '/p/.env', 'staging', 'local')).toBe(false)
  recordValues(state, '/p/.env', 'p', 'staging', {})
  expect(fileHoldsEnvironment(state, '/p/.env', 'staging', 'local')).toBe(true)
  expect(fileHoldsEnvironment(state, '/p/.env', 'local', 'local')).toBe(false)
})
