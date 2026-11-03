import { expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BwenvError } from '../src/errors'
import {
  defaultEnvironment,
  findManifest,
  folderName,
  itemName,
  loadManifest,
  parseManifest,
  resolveFile,
  saveManifest,
} from '../src/manifest'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bwenv-manifest-'))
}

function thrown(fn: () => unknown): BwenvError {
  try {
    fn()
  } catch (error) {
    if (error instanceof BwenvError) return error
    throw error
  }
  throw new Error('expected a BwenvError, nothing was thrown')
}

const VALID = JSON.stringify({
  project: 'my-app',
  variables: { A: { file: '.dev.vars' } },
})

test('findManifest walks up from a subdirectory', () => {
  const root = tempDir()
  writeFileSync(join(root, 'bwenv.json'), VALID)
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  expect(findManifest(join(root, 'src', 'deep'))).toBe(join(root, 'bwenv.json'))
})

test('loadManifest without any manifest is a usage error naming the directory', () => {
  const root = tempDir()
  const error = thrown(() => loadManifest(root))
  expect(error.exitCode).toBe(2)
  expect(error.message).toContain(root)
})

test('resolveFile resolves ~ against home and relative paths against the manifest dir, not cwd', () => {
  const root = tempDir()
  writeFileSync(join(root, 'bwenv.json'), VALID)
  mkdirSync(join(root, 'src'))
  const loaded = loadManifest(join(root, 'src'))
  expect(resolveFile(loaded, '~/.k', '/home/me')).toBe('/home/me/.k')
  expect(resolveFile(loaded, '.dev.vars', '/home/me')).toBe(
    join(root, '.dev.vars'),
  )
  const absolute = thrown(() => resolveFile(loaded, '/etc/x', '/home/me'))
  expect(absolute.exitCode).toBe(2)
  expect(absolute.message).toMatch(/absolute/)
})

test('parseManifest names the file and the field', () => {
  const path = '/p/bwenv.json'
  const cases: [string, string][] = [
    ['{ not json', path],
    [JSON.stringify({ variables: {} }), 'project'],
    [JSON.stringify({ project: 'MyApp', variables: {} }), 'project'],
    [
      JSON.stringify({ project: 'p', variables: { api: { file: '.env' } } }),
      'variables.api',
    ],
    [
      JSON.stringify({
        project: 'p',
        variables: { X: { file: '.env', perEnviroment: true } },
      }),
      'variables.X.perEnviroment',
    ],
    [
      JSON.stringify({ project: 'p', variables: { X: { file: 3 } } }),
      'variables.X.file',
    ],
    [JSON.stringify({ project: 'p', variables: {}, extra: 1 }), 'extra'],
    [
      JSON.stringify({
        project: 'p',
        defaultEnvironment: 'Prod',
        variables: {},
      }),
      'defaultEnvironment',
    ],
  ]
  for (const [text, field] of cases) {
    const error = thrown(() => parseManifest(text, path))
    expect(error.exitCode).toBe(2)
    expect(error.message).toContain(path)
    expect(error.message).toContain(field)
  }
})

test('parseManifest accepts every documented field', () => {
  const manifest = parseManifest(
    JSON.stringify({
      project: 'my-app',
      defaultEnvironment: 'local',
      variables: {
        A: { file: '~/.k', how: 'make it' },
        B: { file: '.dev.vars', perEnvironment: true },
      },
    }),
    '/p/bwenv.json',
  )
  expect(manifest.variables.B?.perEnvironment).toBe(true)
  expect(manifest.variables.A?.how).toBe('make it')
})

test('defaultEnvironment falls back to local', () => {
  expect(defaultEnvironment({ project: 'p', variables: {} })).toBe('local')
  expect(
    defaultEnvironment({
      project: 'p',
      defaultEnvironment: 'dev',
      variables: {},
    }),
  ).toBe('dev')
})

test('item and folder names', () => {
  expect(itemName('my-app', 'A', null)).toBe('my-app/A')
  expect(itemName('my-app', 'A', 'staging')).toBe('my-app/staging/A')
  expect(folderName('my-app')).toBe('bwenv/my-app')
})

test('saveManifest round-trips and ends with one newline', () => {
  const root = tempDir()
  writeFileSync(join(root, 'bwenv.json'), VALID)
  const loaded = loadManifest(root)
  loaded.manifest.variables.B = { file: '.env', how: 'here' }
  saveManifest(loaded)
  const text = readFileSync(join(root, 'bwenv.json'), 'utf8')
  expect(text.endsWith('}\n')).toBe(true)
  expect(text.endsWith('\n\n')).toBe(false)
  expect(loadManifest(root).manifest).toEqual(loaded.manifest)
})

test('parseManifest refuses control characters in how and file', () => {
  for (const [field, spec] of [
    ['variables.X.how', { file: '.env', how: 'see \u001b[2Jhere' }],
    ['variables.X.file', { file: '.env\u0007' }],
    ['variables.X.how', { file: '.env', how: 'c1 \u009b31m' }],
  ] as const) {
    const error = thrown(() =>
      parseManifest(
        JSON.stringify({ project: 'p', variables: { X: spec } }),
        '/p/bwenv.json',
      ),
    )
    expect(error.exitCode).toBe(2)
    expect(error.message).toContain(field)
    expect(error.message).not.toContain('\u001b')
  }
})

test('resolveFile keeps relative paths inside the project and ~ paths inside home', () => {
  const root = tempDir()
  writeFileSync(join(root, 'bwenv.json'), VALID)
  const elsewhere = tempDir()
  symlinkSync(elsewhere, join(root, 'link'))
  const loaded = loadManifest(root)
  for (const file of [
    '../outside/.env',
    'sub/../../x',
    'link/.env',
    '~/../x',
  ]) {
    const error = thrown(() => resolveFile(loaded, file, '/home/me'))
    expect(error.exitCode).toBe(2)
    expect(error.message).toContain(file)
  }
  expect(resolveFile(loaded, 'sub/../.env', '/home/me')).toBe(
    join(root, '.env'),
  )
  expect(resolveFile(loaded, '..dotted', '/home/me')).toBe(
    join(root, '..dotted'),
  )
})
