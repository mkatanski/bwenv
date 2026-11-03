import { beforeAll, expect, test } from 'bun:test'
import { chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadState } from '../src/state'
import {
  FAKE_BW,
  makeSandbox,
  readVault,
  runCli,
  seedItems,
  type Sandbox,
} from './helpers'

beforeAll(() => {
  chmodSync(FAKE_BW, 0o755)
})

const MANIFEST = {
  project: 'p',
  variables: {
    SEG: { file: '.dev.vars', perEnvironment: true },
    A: { file: '.dev.vars' },
  },
}

async function syncedSandbox(): Promise<Sandbox> {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', {
    'p/local/SEG': 'segx1',
    'p/staging/SEG': 'segx2',
    'p/A': 'ax1',
  })
  expect((await runCli(sandbox, ['sync'])).code).toBe(0)
  return sandbox
}

function deleted(sandbox: Sandbox): string[] {
  return readVault(sandbox)
    .items.filter((item) => typeof item.deletedDate === 'string')
    .map((item) => String(item.name))
    .sort()
}

function manifestVariables(sandbox: Sandbox): string[] {
  const raw: unknown = JSON.parse(
    readFileSync(join(sandbox.project, 'bwenv.json'), 'utf8'),
  )
  const manifest = raw as { variables: Record<string, unknown> }
  return Object.keys(manifest.variables)
}

function devVars(sandbox: Sandbox): string {
  return readFileSync(join(sandbox.project, '.dev.vars'), 'utf8')
}

test('rm removes every item, the line, the state hash and the manifest entry', async () => {
  const sandbox = await syncedSandbox()
  const result = await runCli(sandbox, ['rm', 'SEG', '--yes'])
  expect(result.code).toBe(0)
  expect(deleted(sandbox)).toEqual(['p/local/SEG', 'p/staging/SEG'])
  expect(devVars(sandbox)).toBe('A=ax1\n')
  expect(manifestVariables(sandbox)).toEqual(['A'])
  const state = loadState(join(sandbox.stateHome, 'bwenv', 'state.json'))
  for (const entry of Object.values(state)) {
    expect(Object.keys(entry.values)).toEqual(['A'])
  }
  expect(result.stdout).toContain(
    'Removed SEG. Bitwarden keeps deleted items in its trash for 30 days.',
  )
})

test('rm --env removes one environment only', async () => {
  const sandbox = await syncedSandbox()
  const result = await runCli(sandbox, [
    'rm',
    'SEG',
    '--env',
    'staging',
    '--yes',
  ])
  expect(result.code).toBe(0)
  expect(deleted(sandbox)).toEqual(['p/staging/SEG'])
  expect(devVars(sandbox)).toBe('SEG=segx1\nA=ax1\n')
  expect(manifestVariables(sandbox)).toEqual(['SEG', 'A'])
})

test('rm without a TTY or --yes is exit 2 and changes nothing', async () => {
  const sandbox = await syncedSandbox()
  const callsBefore = readVault(sandbox).calls.length
  const result = await runCli(sandbox, ['rm', 'A'])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('Pass --yes to remove A without a prompt.')
  expect(readVault(sandbox).calls).toHaveLength(callsBefore)
  expect(devVars(sandbox)).toBe('SEG=segx1\nA=ax1\n')
})

test('rm of an undeclared name is exit 2', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const result = await runCli(sandbox, ['rm', 'NOPE', '--yes'])
  expect(result.code).toBe(2)
  expect(readVault(sandbox).calls).toEqual([])
})

test('rm with nothing in Bitwarden still removes the line and the entry', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  const result = await runCli(sandbox, ['rm', 'A', '--yes'])
  expect(result.code).toBe(0)
  expect(manifestVariables(sandbox)).toEqual([])
  expect(result.stdout).toContain('There was nothing in Bitwarden to delete.')
})

test('rm refuses an agent', async () => {
  const sandbox = await syncedSandbox()
  const callsBefore = readVault(sandbox).calls.length
  const result = await runCli(sandbox, ['rm', 'A', '--yes'], {
    env: { CLAUDECODE: '1' },
  })
  expect(result.code).toBe(1)
  expect(readVault(sandbox).calls).toHaveLength(callsBefore)
  expect(manifestVariables(sandbox)).toEqual(['SEG', 'A'])
})
