import { beforeAll, expect, test } from 'bun:test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

function storedValue(sandbox: Sandbox, name: string): unknown {
  const login = readVault(sandbox).items.find(
    (item) => item.name === name,
  )?.login
  return typeof login === 'object' && login !== null && 'password' in login
    ? login.password
    : undefined
}

function devVars(sandbox: Sandbox): string {
  return readFileSync(join(sandbox.project, '.dev.vars'), 'utf8')
}

function syncedSandbox(): Sandbox {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  seedItems(sandbox, 'p', { 'p/A': 'vax1' })
  return sandbox
}

test('update replaces the value and the file, and a later sync is clean', async () => {
  const sandbox = syncedSandbox()
  expect((await runCli(sandbox, ['sync'])).code).toBe(0)
  const result = await runCli(sandbox, ['update', 'A'], { stdin: 'newx1\n' })
  expect(result.code).toBe(0)
  expect(`${result.stdout}${result.stderr}`).not.toContain('newx1')
  expect(storedValue(sandbox, 'p/A')).toBe('newx1')
  expect(devVars(sandbox)).toBe('A=newx1\n')
  const again = await runCli(sandbox, ['sync'])
  expect(again.code).toBe(0)
  expect(again.stdout).toContain('A  unchanged')
})

test('update --from-file resolves a conflict in favour of the file', async () => {
  const sandbox = syncedSandbox()
  await runCli(sandbox, ['sync'])
  writeFileSync(join(sandbox.project, '.dev.vars'), 'A=handx1\n')
  expect((await runCli(sandbox, ['sync'])).code).toBe(1)
  const result = await runCli(sandbox, ['update', 'A', '--from-file'])
  expect(result.code).toBe(0)
  expect(storedValue(sandbox, 'p/A')).toBe('handx1')
  expect((await runCli(sandbox, ['sync'])).code).toBe(0)
})

test('update of a missing item points to add', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  const result = await runCli(sandbox, ['update', 'A'], { stdin: 'x' })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('Use: bwenv add A')
})

test('update of an undeclared name is exit 2 and points to add', async () => {
  const sandbox = makeSandbox({ project: 'p', variables: {} })
  const result = await runCli(sandbox, ['update', 'A'], { stdin: 'x' })
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('bwenv add A --file <path>')
  expect(readVault(sandbox).calls).toEqual([])
})

test('update refuses an agent', async () => {
  const sandbox = syncedSandbox()
  const result = await runCli(sandbox, ['update', 'A'], {
    stdin: 'x',
    env: { CLAUDECODE: '1' },
  })
  expect(result.code).toBe(1)
  expect(readVault(sandbox).calls).toEqual([])
})

test('--from-file never sends one environment value into another environment', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { SEG: { file: '.dev.vars', perEnvironment: true } },
  })
  seedItems(sandbox, 'p', {
    'p/staging/SEG': 'stagx1',
    'p/production/SEG': 'prodx1',
  })
  expect((await runCli(sandbox, ['sync', '--env', 'staging'])).code).toBe(0)

  const update = await runCli(sandbox, [
    'update',
    'SEG',
    '--env',
    'production',
    '--from-file',
  ])
  expect(update.code).toBe(1)
  expect(update.stderr).toContain('holds staging values')
  expect(update.stderr).toContain('bwenv sync --env production')
  expect(storedValue(sandbox, 'p/production/SEG')).toBe('prodx1')

  const add = await runCli(sandbox, [
    'add',
    'SEG',
    '--env',
    'dev',
    '--from-file',
  ])
  expect(add.code).toBe(1)
  expect(storedValue(sandbox, 'p/dev/SEG')).toBeUndefined()
})
