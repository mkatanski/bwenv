import { beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
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

function listSandbox(): Sandbox {
  const sandbox = makeSandbox({
    project: 'p',
    variables: {
      A: { file: '.dev.vars' },
      B: { file: '.dev.vars', how: 'make B here' },
    },
  })
  writeFileSync(join(sandbox.project, '.dev.vars'), 'A=valueA\nC=valueC\n')
  return sandbox
}

function expectListing(stdout: string): void {
  expect(stdout).toContain('.dev.vars')
  expect(stdout).toContain('  A  set')
  expect(stdout).toContain('  B  missing — make B here')
  expect(stdout).toContain('  C  set, not declared in bwenv.json')
  expect(stdout).not.toContain('valueA')
  expect(stdout).not.toContain('valueC')
}

test('list shows set and missing without values and runs with the vault locked', async () => {
  const sandbox = listSandbox()
  const result = await runCli(sandbox, ['list'], { env: { BW_SESSION: '' } })
  expect(result.code).toBe(0)
  expectListing(result.stdout)
  expect(readVault(sandbox).calls).toEqual([])
})

test('list works from a subdirectory', async () => {
  const sandbox = listSandbox()
  mkdirSync(join(sandbox.project, 'src'))
  const result = await runCli(sandbox, ['list'], {
    cwd: join(sandbox.project, 'src'),
  })
  expect(result.code).toBe(0)
  expectListing(result.stdout)
})

test('list runs for an agent', async () => {
  const sandbox = listSandbox()
  const result = await runCli(sandbox, ['list'], { env: { CLAUDECODE: '1' } })
  expect(result.code).toBe(0)
  expectListing(result.stdout)
})

test('list --file keeps one file only', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' }, K: { file: '~/.k' } },
  })
  const result = await runCli(sandbox, ['list', '--file', '~/.k'])
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('K  missing')
  expect(result.stdout).not.toContain('A  missing')
})

test('help prints usage and an unknown command exits 2', async () => {
  const sandbox = listSandbox()
  const help = await runCli(sandbox, ['help'])
  expect(help.code).toBe(0)
  expect(help.stdout).toContain('Usage:')
  const bogus = await runCli(sandbox, ['frobnicate'])
  expect(bogus.code).toBe(2)
  expect(bogus.stderr).toContain('Usage:')
})

test('list --vault shows same, differs, not in vault and in vault without values', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: {
      A: { file: '.dev.vars' },
      B: { file: '.dev.vars' },
      C: { file: '.dev.vars' },
      D: { file: '.dev.vars' },
    },
  })
  writeFileSync(
    join(sandbox.project, '.dev.vars'),
    'A=samex1\nB=localx1\nC=onlyx1\n',
  )
  seedItems(sandbox, 'p', { 'p/A': 'samex1', 'p/B': 'vaultx1', 'p/D': 'dx1' })
  const result = await runCli(sandbox, ['list', '--vault'])
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('  A  set · same')
  expect(result.stdout).toContain('  B  set · differs')
  expect(result.stdout).toContain('  C  set · not in vault')
  expect(result.stdout).toContain('  D  missing · in vault')
  for (const value of ['samex1', 'localx1', 'vaultx1', 'onlyx1', 'dx1']) {
    expect(result.stdout).not.toContain(value)
  }
})

test('list --vault refuses an agent', async () => {
  const sandbox = listSandbox()
  const result = await runCli(sandbox, ['list', '--vault'], {
    env: { CLAUDECODE: '1' },
  })
  expect(result.code).toBe(1)
  expect(readVault(sandbox).calls).toEqual([])
})

test('list --file is relative to where you stand', async () => {
  const sandbox = listSandbox()
  mkdirSync(join(sandbox.project, 'sub'))
  const result = await runCli(sandbox, ['list', '--file', '../.dev.vars'], {
    cwd: join(sandbox.project, 'sub'),
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('  A  set')
})
