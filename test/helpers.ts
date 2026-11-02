import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeFolder {
  id: string
  name: string
}

export interface FakeCall {
  argv: string[]
  stdin: string
  sessionOk: boolean
}

export interface FakeVault {
  status: 'locked' | 'unauthenticated'
  session: string
  folders: FakeFolder[]
  items: Record<string, unknown>[]
  calls: FakeCall[]
}

export interface Sandbox {
  root: string
  home: string
  stateHome: string
  project: string
  vaultPath: string
}

export const FAKE_BW = join(import.meta.dir, 'fake-bw.ts')
export const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

export function makeSandbox(
  manifest: unknown,
  options: { gitignore?: string } = {},
): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'bwenv-sandbox-'))
  const sandbox: Sandbox = {
    root,
    home: join(root, 'home'),
    stateHome: join(root, 'state'),
    project: join(root, 'project'),
    vaultPath: join(root, 'vault.json'),
  }
  mkdirSync(sandbox.home)
  mkdirSync(sandbox.project)
  Bun.spawnSync(['git', 'init', '-q', sandbox.project])
  writeFileSync(
    join(sandbox.project, 'bwenv.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  writeFileSync(
    join(sandbox.project, '.gitignore'),
    options.gitignore ?? '.dev.vars\n.env\n',
  )
  writeVault(sandbox, {
    status: 'locked',
    session: 'session-ok',
    folders: [],
    items: [],
    calls: [],
  })
  return sandbox
}

export function readVault(sandbox: Sandbox): FakeVault {
  const raw: unknown = JSON.parse(readFileSync(sandbox.vaultPath, 'utf8'))
  return raw as FakeVault
}

export function writeVault(sandbox: Sandbox, vault: FakeVault): void {
  writeFileSync(sandbox.vaultPath, JSON.stringify(vault, null, 2))
}

export function seedItems(
  sandbox: Sandbox,
  project: string,
  values: Record<string, string>,
): void {
  const vault = readVault(sandbox)
  const folderName = `bwenv/${project}`
  let folder = vault.folders.find((f) => f.name === folderName)
  if (!folder) {
    folder = { id: crypto.randomUUID(), name: folderName }
    vault.folders.push(folder)
  }
  for (const [name, value] of Object.entries(values)) {
    vault.items.push({
      id: crypto.randomUUID(),
      folderId: folder.id,
      type: 1,
      name,
      notes: null,
      login: { username: name.split('/').at(-1), password: value },
      passwordHistory: null,
    })
  }
  writeVault(sandbox, vault)
}

export function sandboxEnv(
  sandbox: Sandbox,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: sandbox.home,
    XDG_STATE_HOME: sandbox.stateHome,
    BWENV_BW: FAKE_BW,
    BWENV_FAKE_VAULT: sandbox.vaultPath,
    BW_SESSION: 'session-ok',
    ...extra,
  }
}

export async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected a rejection, the promise resolved')
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export async function runCli(
  sandbox: Sandbox,
  args: string[],
  options: { stdin?: string; env?: Record<string, string>; cwd?: string } = {},
): Promise<CliResult> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd: options.cwd ?? sandbox.project,
    env: sandboxEnv(sandbox, options.env),
    stdin:
      options.stdin === undefined
        ? 'ignore'
        : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}
