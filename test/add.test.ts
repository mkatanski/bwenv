import { beforeAll, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  FAKE_BW,
  makeSandbox,
  readVault,
  runCli,
  seedItems,
  type CliResult,
  type Sandbox,
} from './helpers'

beforeAll(() => {
  chmodSync(FAKE_BW, 0o755)
})

function storedValue(sandbox: Sandbox, name: string): unknown {
  const item = readVault(sandbox).items.find(
    (candidate) => candidate.name === name && !candidate.deletedDate,
  )
  const login = item?.login
  return typeof login === 'object' && login !== null && 'password' in login
    ? login.password
    : undefined
}

function manifestOf(sandbox: Sandbox): unknown {
  return JSON.parse(readFileSync(join(sandbox.project, 'bwenv.json'), 'utf8'))
}

function commands(sandbox: Sandbox): string[] {
  return readVault(sandbox).calls.map((call) => call.argv.slice(2, 4).join(' '))
}

function expectQuiet(result: CliResult, value: string): void {
  expect(`${result.stdout}${result.stderr}`).not.toContain(value)
}

test('add declares, stores and writes', async () => {
  const sandbox = makeSandbox({ project: 'p', variables: {} })
  const result = await runCli(
    sandbox,
    ['add', 'NEW', '--file', '.env', '--how', 'get it there'],
    { stdin: 'tokx9\n' },
  )
  expect(result.code).toBe(0)
  expectQuiet(result, 'tokx9')
  expect(storedValue(sandbox, 'p/NEW')).toBe('tokx9')
  expect(readFileSync(join(sandbox.project, '.env'), 'utf8')).toBe(
    'NEW=tokx9\n',
  )
  expect(manifestOf(sandbox)).toEqual({
    project: 'p',
    variables: { NEW: { file: '.env', how: 'get it there' } },
  })
  const item = readVault(sandbox).items[0]
  expect(item?.notes).toBe(
    'get it there\n\nManaged by bwenv · project p · file .env',
  )
  expect(readVault(sandbox).folders.map((folder) => folder.name)).toEqual([
    'bwenv/p',
  ])
  expect(result.stdout).toContain(
    'Added NEW to Bitwarden (bwenv/p) and to .env',
  )
})

test('add a new variable with --env declares it perEnvironment', async () => {
  const sandbox = makeSandbox({ project: 'p', variables: {} })
  const result = await runCli(
    sandbox,
    ['add', 'SEG', '--file', '.env', '--env', 'local'],
    { stdin: 'segx1' },
  )
  expect(result.code).toBe(0)
  expect(storedValue(sandbox, 'p/local/SEG')).toBe('segx1')
  expect(manifestOf(sandbox)).toEqual({
    project: 'p',
    variables: { SEG: { file: '.env', perEnvironment: true } },
  })
})

test('add an existing name is refused before any value is read', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  seedItems(sandbox, 'p', { 'p/A': 'oldx1' })
  const result = await runCli(sandbox, ['add', 'A'], { stdin: 'newx1' })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain(
    'A is already in Bitwarden. Use: bwenv update A',
  )
  expect(storedValue(sandbox, 'p/A')).toBe('oldx1')
  expect(commands(sandbox)).not.toContain('create item')
})

test('add undeclared without --file is exit 2 and touches nothing', async () => {
  const sandbox = makeSandbox({ project: 'p', variables: {} })
  const result = await runCli(sandbox, ['add', 'NEW'], { stdin: 'x' })
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('Pass --file <path> to declare it')
  expect(readVault(sandbox).calls).toEqual([])
})

test('add with a --file other than the declared one is exit 2', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  const result = await runCli(sandbox, ['add', 'A', '--file', '.env'])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('A is declared for .dev.vars')
  expect(readVault(sandbox).calls).toEqual([])
})

test('add --env on a shared variable is exit 2', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  const result = await runCli(sandbox, ['add', 'A', '--env', 'staging'])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('same in every environment')
})

test('add --from-file sends the file value', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  writeFileSync(join(sandbox.project, '.dev.vars'), 'A=fromdiskx1\n')
  const result = await runCli(sandbox, ['add', 'A', '--from-file'])
  expect(result.code).toBe(0)
  expectQuiet(result, 'fromdiskx1')
  expect(storedValue(sandbox, 'p/A')).toBe('fromdiskx1')
})

test('add --from-file with the key absent from the file is refused', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  const result = await runCli(sandbox, ['add', 'A', '--from-file'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('--from-file has nothing to send')
  expect(commands(sandbox)).not.toContain('create item')
})

test('add empty stdin is refused before the vault is written', async () => {
  const sandbox = makeSandbox({ project: 'p', variables: {} })
  const result = await runCli(sandbox, ['add', 'NEW', '--file', '.env'], {
    stdin: '\n',
  })
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('NEW is empty')
  expect(commands(sandbox)).not.toContain('create item')
  expect(commands(sandbox)).not.toContain('create folder')
  expect(existsSync(join(sandbox.project, '.env'))).toBe(false)
})

test('add perEnvironment to a non-current environment writes the vault only', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { SEG: { file: '.dev.vars', perEnvironment: true } },
  })
  seedItems(sandbox, 'p', { 'p/staging/SEG': 'stagx1' })
  expect((await runCli(sandbox, ['sync', '--env', 'staging'])).code).toBe(0)

  const result = await runCli(sandbox, ['add', 'SEG', '--env', 'production'], {
    stdin: 'prodx1',
  })
  expect(result.code).toBe(0)
  expect(storedValue(sandbox, 'p/production/SEG')).toBe('prodx1')
  expect(readFileSync(join(sandbox.project, '.dev.vars'), 'utf8')).toBe(
    'SEG=stagx1\n',
  )
  expect(result.stdout).toContain('Saved to Bitwarden only')
  expect(result.stdout).toContain('bwenv sync --env production')
})

test('add to a file git does not ignore is refused before the vault opens', async () => {
  const sandbox = makeSandbox(
    { project: 'p', variables: {} },
    { gitignore: '' },
  )
  const result = await runCli(sandbox, ['add', 'NEW', '--file', '.env'], {
    stdin: 'x',
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('not ignored by git')
  expect(readVault(sandbox).calls).toEqual([])
})

test('agents are refused before any prompt', async () => {
  const sandbox = makeSandbox({ project: 'p', variables: {} })
  const result = await runCli(sandbox, ['add', 'NEW', '--file', '.env'], {
    stdin: 'x',
    env: { CLAUDECODE: '1' },
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('does not open the vault for an agent')
  expect(readVault(sandbox).calls).toEqual([])
  expect(manifestOf(sandbox)).toEqual({ project: 'p', variables: {} })
})

test('add --file is relative to where you stand, stored relative to bwenv.json', async () => {
  const sandbox = makeSandbox({ project: 'p', variables: {} })
  mkdirSync(join(sandbox.project, 'sub'))
  const result = await runCli(sandbox, ['add', 'X', '--file', '.dev.vars'], {
    cwd: join(sandbox.project, 'sub'),
    stdin: 'xvalx1',
  })
  expect(result.code).toBe(0)
  expect(manifestOf(sandbox)).toEqual({
    project: 'p',
    variables: { X: { file: 'sub/.dev.vars' } },
  })
  expect(readFileSync(join(sandbox.project, 'sub', '.dev.vars'), 'utf8')).toBe(
    'X=xvalx1\n',
  )
  expect(existsSync(join(sandbox.project, '.dev.vars'))).toBe(false)
})

test('add --file accepts another spelling of the declared file', async () => {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { A: { file: '.dev.vars' } },
  })
  const result = await runCli(sandbox, ['add', 'A', '--file', './.dev.vars'], {
    stdin: 'avalx1',
  })
  expect(result.code).toBe(0)
})
