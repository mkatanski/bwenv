import { expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BwenvError } from '../src/errors'
import { assertIgnoredIfInRepo, readText, writeSecretFile } from '../src/files'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bwenv-files-'))
}

function gitRepo(gitignore: string): string {
  const dir = tempDir()
  Bun.spawnSync(['git', 'init', '-q', dir])
  writeFileSync(join(dir, '.gitignore'), gitignore)
  return dir
}

test('readText returns null for a missing file', () => {
  expect(readText(join(tempDir(), 'absent'))).toBeNull()
})

test('writeSecretFile creates missing parent dirs and leaves mode 0600', () => {
  const dir = tempDir()
  const target = join(dir, 'a', 'b', '.env')
  writeSecretFile(target, 'A=1\n')
  expect(readFileSync(target, 'utf8')).toBe('A=1\n')
  expect(statSync(target).mode & 0o777).toBe(0o600)
  expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['.env'])
})

test('writeSecretFile tightens the mode of an existing file', () => {
  const target = join(tempDir(), '.env')
  writeFileSync(target, 'OLD=1\n', { mode: 0o644 })
  writeSecretFile(target, 'A=1\n')
  expect(statSync(target).mode & 0o777).toBe(0o600)
})

test('assertIgnoredIfInRepo passes for an ignored path, even before it exists', () => {
  const repo = gitRepo('.dev.vars\n')
  expect(() => {
    assertIgnoredIfInRepo(join(repo, '.dev.vars'))
  }).not.toThrow()
  expect(() => {
    assertIgnoredIfInRepo(join(repo, 'sub', 'dir', '.dev.vars'))
  }).not.toThrow()
})

test('assertIgnoredIfInRepo passes for a path outside any repo', () => {
  expect(() => {
    assertIgnoredIfInRepo(join(tempDir(), '.k'))
  }).not.toThrow()
})

test('assertIgnoredIfInRepo refuses a path git would track', () => {
  const repo = gitRepo('')
  try {
    assertIgnoredIfInRepo(join(repo, '.env'))
    throw new Error('expected a refusal')
  } catch (error) {
    expect(error).toBeInstanceOf(BwenvError)
    expect((error as BwenvError).exitCode).toBe(1)
    expect((error as BwenvError).message).toMatch(/not ignored by git/)
  }
})
