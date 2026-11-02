import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

import { BwenvError } from './errors'

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

export function writeSecretFile(path: string, text: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const suffix = randomBytes(8).toString('hex')
  const temporary = join(dir, `.${basename(path)}.bwenv-${suffix}`)
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeFileSync(fd, text)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function nearestExistingDir(path: string): string {
  let dir = dirname(path)
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
}

function git(cwd: string, args: string[]): { code: number; stdout: string } {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  return { code: result.exitCode, stdout: result.stdout.toString() }
}

export function assertIgnoredIfInRepo(path: string): void {
  const cwd = nearestExistingDir(path)
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return

  const ignored = git(cwd, [
    '-c',
    'core.excludesFile=/dev/null',
    'check-ignore',
    '-q',
    '--',
    relative(cwd, path),
  ])
  if (ignored.code === 0) return

  throw new BwenvError(
    `${path} is not ignored by git. Add it to .gitignore first, so the secret cannot be committed. Nothing was written.`,
  )
}
