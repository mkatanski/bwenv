import { BwenvError } from './errors'
import { folderName } from './manifest'

type Env = Record<string, string | undefined>

interface Writer {
  write(text: string): unknown
}

export interface VaultItem {
  id: string
  name: string
  value: string | null
  raw: Record<string, unknown>
}

type Runner = (args: string[], input?: string) => Promise<unknown>

const UNREADABLE = 'The Bitwarden CLI answered in a shape bwenv cannot read.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setting(env: Env, key: string): string | null {
  const value = env[key]
  return value === undefined || value === '' ? null : value
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

function childEnv(env: Env, session: string | null): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== 'BW_SESSION') result[key] = value
  }
  if (session !== null) result.BW_SESSION = session
  return result
}

function makeRunner(binary: string, env: Env, session: string | null): Runner {
  return async (args, input) => {
    const proc = Bun.spawn([binary, '--nointeraction', '--response', ...args], {
      env: childEnv(env, session),
      stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    let response: unknown
    try {
      response = JSON.parse(stdout)
    } catch {
      throw new BwenvError(UNREADABLE)
    }
    if (!isRecord(response) || typeof response.success !== 'boolean') {
      throw new BwenvError(UNREADABLE)
    }
    if (!response.success) {
      const message =
        typeof response.message === 'string' ? response.message : 'no reason'
      throw new BwenvError(`Bitwarden refused: ${message}`)
    }
    return response.data
  }
}

function listOf(data: unknown): Record<string, unknown>[] {
  if (!isRecord(data) || !Array.isArray(data.data)) {
    throw new BwenvError(UNREADABLE)
  }
  return data.data.filter(isRecord)
}

function toVaultItem(raw: Record<string, unknown>): VaultItem {
  const { id, name, login } = raw
  if (typeof id !== 'string' || typeof name !== 'string') {
    throw new BwenvError(UNREADABLE)
  }
  const password = isRecord(login) ? login.password : null
  return {
    id,
    name,
    value: typeof password === 'string' ? password : null,
    raw,
  }
}

export function assertNotAgent(env: Env, ownerCommand: string): void {
  if (env.CLAUDECODE === '1') {
    throw new BwenvError(
      `bwenv does not open the vault for an agent. Ask the owner to run: ${ownerCommand}`,
    )
  }
}

export class Vault {
  readonly #run: Runner

  constructor(run: Runner) {
    this.#run = run
  }

  async sync(): Promise<void> {
    await this.#run(['sync'])
  }

  async folderId(project: string, create: boolean): Promise<string | null> {
    const name = folderName(project)
    const found = listOf(
      await this.#run(['list', 'folders', '--search', name]),
    ).filter((folder) => folder.name === name)
    if (found.length > 1) {
      throw new BwenvError(
        `Bitwarden has ${String(found.length)} folders named ${name}. Merge them in Bitwarden, then run this again.`,
      )
    }
    const existing = found[0]?.id
    if (typeof existing === 'string') return existing
    if (!create) return null

    const created = await this.#run(['create', 'folder'], encode({ name }))
    if (!isRecord(created) || typeof created.id !== 'string') {
      throw new BwenvError(UNREADABLE)
    }
    return created.id
  }

  async items(folderId: string): Promise<VaultItem[]> {
    return listOf(
      await this.#run(['list', 'items', '--folderid', folderId]),
    ).map(toVaultItem)
  }

  findItem(items: VaultItem[], name: string): VaultItem | null {
    const matches = items.filter((item) => item.name === name)
    if (matches.length > 1) {
      throw new BwenvError(
        `Bitwarden has ${String(matches.length)} items named ${name}. Delete the extra ones in Bitwarden, then run this again.`,
      )
    }
    return matches[0] ?? null
  }

  async createItem(
    folderId: string,
    name: string,
    username: string,
    value: string,
    notes: string,
  ): Promise<void> {
    await this.#run(
      ['create', 'item'],
      encode({
        organizationId: null,
        collectionIds: null,
        folderId,
        type: 1,
        name,
        notes,
        favorite: false,
        fields: [],
        login: { uris: [], username, password: value, totp: null },
        secureNote: null,
        card: null,
        identity: null,
        reprompt: 0,
      }),
    )
  }

  async updateValue(item: VaultItem, value: string): Promise<void> {
    const login = isRecord(item.raw.login) ? item.raw.login : {}
    await this.#run(
      ['edit', 'item', item.id],
      encode({ ...item.raw, login: { ...login, password: value } }),
    )
  }

  async deleteItem(id: string): Promise<void> {
    await this.#run(['delete', 'item', id])
  }
}

async function unlock(
  binary: string,
  env: Env,
  stderr: Writer,
): Promise<string> {
  const proc = Bun.spawn([binary, 'unlock', '--raw'], {
    env: childEnv(env, null),
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'inherit',
  })
  const [session, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ])
  if (code !== 0 || session.trim() === '') {
    throw new BwenvError('Unlocking the vault failed. Nothing was written.')
  }
  stderr.write(
    'Tip: export BW_SESSION=$(bw unlock --raw) in your shell to skip this prompt.\n',
  )
  return session.trim()
}

async function vaultStatus(
  binary: string,
  env: Env,
  session: string | null,
): Promise<string> {
  const data = await makeRunner(binary, env, session)(['status'])
  const template = isRecord(data) ? data.template : null
  const status = isRecord(template) ? template.status : null
  if (typeof status !== 'string') throw new BwenvError(UNREADABLE)
  return status
}

export async function openVault(options: {
  env: Env
  isTTY: boolean
  ownerCommand: string
  stderr: Writer
}): Promise<Vault> {
  const { env, isTTY, ownerCommand, stderr } = options
  assertNotAgent(env, ownerCommand)

  const binary = setting(env, 'BWENV_BW') ?? 'bw'
  const existing = setting(env, 'BW_SESSION')
  const status = await vaultStatus(binary, env, existing)

  if (status === 'unauthenticated') {
    throw new BwenvError('The Bitwarden CLI is not logged in. Run: bw login')
  }

  let session: string
  if (status === 'unlocked' && existing !== null) {
    session = existing
  } else if (isTTY) {
    session = await unlock(binary, env, stderr)
  } else {
    throw new BwenvError(
      'The Bitwarden vault is locked. Unlock it in your shell: export BW_SESSION=$(bw unlock --raw) — then run this again.',
    )
  }

  const vault = new Vault(makeRunner(binary, env, session))
  await vault.sync()
  return vault
}
