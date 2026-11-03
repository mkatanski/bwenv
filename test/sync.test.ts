import { beforeAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { hashValue, loadState, type FileState } from '../src/state'
import {
  FAKE_BW,
  makeSandbox,
  readVault,
  runCli,
  seedItems,
  writeVault,
  type CliResult,
  type Sandbox,
} from './helpers'

beforeAll(() => {
  chmodSync(FAKE_BW, 0o755)
})

const MANIFEST = {
  project: 'p',
  variables: {
    A: { file: '.dev.vars', how: 'make A at example.com' },
    B: { file: '.dev.vars' },
  },
}

const SECRETS = [
  'va',
  'vb',
  'va2',
  'handx1',
  'otherx2',
  'shared',
  'local-seg',
  'staging-seg',
]

function expectNoValues(result: CliResult): void {
  const output = `${result.stdout}\n${result.stderr}`
  for (const secret of SECRETS) {
    expect(output).not.toMatch(new RegExp(`(^|[^\\w-])${secret}([^\\w-]|$)`))
  }
}

function devVars(sandbox: Sandbox): string {
  return readFileSync(join(sandbox.project, '.dev.vars'), 'utf8')
}

function onlyState(sandbox: Sandbox): FileState {
  const states = Object.values(
    loadState(join(sandbox.stateHome, 'bwenv', 'state.json')),
  )
  expect(states).toHaveLength(1)
  const [state] = states
  if (!state) throw new Error('no state')
  return state
}

function setVaultValue(sandbox: Sandbox, name: string, value: string): void {
  const vault = readVault(sandbox)
  const item = vault.items.find((candidate) => candidate.name === name)
  if (!item) throw new Error(`no item ${name}`)
  item.login = { username: name, password: value }
  writeVault(sandbox, vault)
}

async function sync(sandbox: Sandbox, args: string[] = []): Promise<CliResult> {
  const result = await runCli(sandbox, ['sync', ...args])
  expectNoValues(result)
  return result
}

test('sync writes every declared value and records hashes', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  const result = await sync(sandbox)
  expect(result.code).toBe(0)
  expect(devVars(sandbox)).toBe('A=va\nB=vb\n')
  expect(statSync(join(sandbox.project, '.dev.vars')).mode & 0o777).toBe(0o600)
  expect(onlyState(sandbox)).toMatchObject({
    project: 'p',
    environment: 'local',
    values: { A: hashValue('va'), B: hashValue('vb') },
  })
  expect(result.stdout).toContain('A  written')
})

test('sync keeps unrelated lines', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  writeFileSync(join(sandbox.project, '.dev.vars'), '# note\nOTHER=1\n')
  expect((await sync(sandbox)).code).toBe(0)
  expect(devVars(sandbox)).toBe('# note\nOTHER=1\nA=va\nB=vb\n')
})

test('a second sync with nothing new reports unchanged and exits 0', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  await sync(sandbox)
  const again = await sync(sandbox)
  expect(again.code).toBe(0)
  expect(again.stdout).toContain('A  unchanged')
})

test('a value bwenv wrote is replaced when the vault changes', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  await sync(sandbox)
  setVaultValue(sandbox, 'p/A', 'va2')
  expect((await sync(sandbox)).code).toBe(0)
  expect(devVars(sandbox)).toBe('A=va2\nB=vb\n')
})

test('hand edit is a conflict and is left alone', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  await sync(sandbox)
  writeFileSync(join(sandbox.project, '.dev.vars'), 'A=handx1\nB=vb\n')
  setVaultValue(sandbox, 'p/A', 'va2')
  const result = await sync(sandbox)
  expect(result.code).toBe(1)
  expect(devVars(sandbox)).toBe('A=handx1\nB=vb\n')
  expect(result.stdout).toContain('conflict')
  expect(result.stdout).toContain('bwenv update A --from-file')
  expect(result.stdout).toContain('bwenv sync --force')
})

test('pre-existing differing value with no record is a conflict', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  writeFileSync(join(sandbox.project, '.dev.vars'), 'A=otherx2\n')
  const result = await sync(sandbox)
  expect(result.code).toBe(1)
  expect(devVars(sandbox)).toBe('A=otherx2\nB=vb\n')
})

test('--force takes the vault value', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  writeFileSync(join(sandbox.project, '.dev.vars'), 'A=otherx2\n')
  expect((await sync(sandbox, ['--force'])).code).toBe(0)
  expect(devVars(sandbox)).toBe('A=va\nB=vb\n')
})

test('missing in vault keeps the local value and prints how', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/B': 'vb' })
  writeFileSync(join(sandbox.project, '.dev.vars'), 'A=otherx2\n')
  const result = await sync(sandbox)
  expect(result.code).toBe(1)
  expect(devVars(sandbox)).toBe('A=otherx2\nB=vb\n')
  expect(result.stdout).toContain('make A at example.com')
  expect(result.stdout).toContain('bwenv add A')
})

test('an empty vault reports every variable as missing and creates no file', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const result = await sync(sandbox)
  expect(result.code).toBe(1)
  expect(existsSync(join(sandbox.project, '.dev.vars'))).toBe(false)
  expect(result.stdout).toContain('bwenv add B')
})

test('--env staging uses only staging items for perEnvironment variables', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: {
      SEG: { file: '.dev.vars', perEnvironment: true },
      A: { file: '.dev.vars' },
    },
  })
  seedItems(sandbox, 'p', { 'p/local/SEG': 'local-seg', 'p/A': 'shared' })
  expect((await sync(sandbox)).code).toBe(0)
  expect(devVars(sandbox)).toBe('SEG=local-seg\nA=shared\n')

  const partial = await sync(sandbox, ['--env', 'staging'])
  expect(partial.code).toBe(1)
  expect(partial.stdout).toContain('not in Bitwarden for staging')
  expect(devVars(sandbox)).toBe('SEG=local-seg\nA=shared\n')
  expect(onlyState(sandbox).environment).toBe('local')

  seedItems(sandbox, 'p', { 'p/staging/SEG': 'staging-seg' })
  expect((await sync(sandbox, ['--env', 'staging'])).code).toBe(0)
  expect(devVars(sandbox)).toBe('SEG=staging-seg\nA=shared\n')
  expect(onlyState(sandbox).environment).toBe('staging')
})

test('--file filters', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' }, K: { file: '~/.k' } },
  })
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/K': 'vb' })
  expect((await sync(sandbox, ['--file', '.dev.vars'])).code).toBe(0)
  expect(devVars(sandbox)).toBe('A=va\n')
  expect(existsSync(join(sandbox.home, '.k'))).toBe(false)
})

test('home files are written too', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { K: { file: '~/.k' } },
  })
  seedItems(sandbox, 'p', { 'p/K': 'vb' })
  expect((await sync(sandbox)).code).toBe(0)
  expect(readFileSync(join(sandbox.home, '.k'), 'utf8')).toBe('K=vb\n')
})

test('a file git does not ignore is refused and not created', async () => {
  const sandbox = makeSandbox(MANIFEST, { gitignore: '' })
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  const result = await sync(sandbox)
  expect(result.code).toBe(1)
  expect(result.stdout).toContain('not ignored by git')
  expect(existsSync(join(sandbox.project, '.dev.vars'))).toBe(false)
})

test('a vault value bwenv cannot write unquoted is reported, not written', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'has space', 'p/B': 'vb' })
  const result = await sync(sandbox)
  expect(result.code).toBe(1)
  expect(devVars(sandbox)).toBe('B=vb\n')
  expect(result.stdout).not.toContain('has space')
})

test('sync refuses an agent', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'va', 'p/B': 'vb' })
  const result = await runCli(sandbox, ['sync'], { env: { CLAUDECODE: '1' } })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('does not open the vault for an agent')
  expect(readVault(sandbox).calls).toEqual([])
})
