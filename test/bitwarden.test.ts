import { chmodSync } from 'node:fs'
import { beforeAll, expect, test } from 'bun:test'

import { openVault, type Vault } from '../src/bitwarden'
import {
  FAKE_BW,
  makeSandbox,
  readVault,
  rejectionOf,
  sandboxEnv,
  seedItems,
  writeVault,
  type Sandbox,
} from './helpers'

const MANIFEST = { project: 'p', variables: {} }

beforeAll(() => {
  chmodSync(FAKE_BW, 0o755)
})

function quietStderr(): { write(text: string): boolean; text: string } {
  return {
    text: '',
    write(text: string) {
      this.text += text
      return true
    },
  }
}

async function open(
  sandbox: Sandbox,
  extra: Record<string, string> = {},
): Promise<Vault> {
  return openVault({
    env: sandboxEnv(sandbox, extra),
    isTTY: false,
    ownerCommand: 'bwenv sync',
    stderr: quietStderr(),
  })
}

test('refuses an agent before calling bw', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const error = await rejectionOf(open(sandbox, { CLAUDECODE: '1' }))
  expect(error.message).toMatch(
    /does not open the vault for an agent\. Ask the owner to run: bwenv sync/,
  )
  expect(readVault(sandbox).calls).toEqual([])
})

test('unauthenticated says bw login', async () => {
  const sandbox = makeSandbox(MANIFEST)
  writeVault(sandbox, { ...readVault(sandbox), status: 'unauthenticated' })
  expect((await rejectionOf(open(sandbox))).message).toMatch(/Run: bw login/)
})

test('locked without a TTY gives the export line', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const error = await rejectionOf(open(sandbox, { BW_SESSION: '' }))
  expect(error.message).toContain('export BW_SESSION=$(bw unlock --raw)')
})

test('a valid session syncs before anything else', async () => {
  const sandbox = makeSandbox(MANIFEST)
  await open(sandbox)
  const commands = readVault(sandbox).calls.map((call) => call.argv.at(2))
  expect(commands).toEqual(['status', 'sync'])
})

test('create, find, update and delete round-trip', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const vault = await open(sandbox)
  const folderId = await vault.folderId('p', true)
  expect(await vault.folderId('p', true)).toBe(folderId)
  expect(readVault(sandbox).folders).toEqual([
    { id: folderId ?? '', name: 'bwenv/p' },
  ])
  if (folderId === null) throw new Error('no folder')

  await vault.createItem(folderId, 'p/A', 'A', 'first', 'how\n\nManaged')
  const stored = readVault(sandbox).items[0]
  expect(stored?.type).toBe(1)
  expect(stored?.login).toMatchObject({ username: 'A', password: 'first' })

  const created = vault.findItem(await vault.items(folderId), 'p/A')
  expect(created?.value).toBe('first')
  if (!created) throw new Error('no item')

  await vault.updateValue(created, 'second')
  const updated = vault.findItem(await vault.items(folderId), 'p/A')
  expect(updated?.value).toBe('second')
  expect(updated?.id).toBe(created.id)

  await vault.deleteItem(created.id)
  expect(vault.findItem(await vault.items(folderId), 'p/A')).toBeNull()
})

test('folderId without create returns null for a missing folder', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const vault = await open(sandbox)
  expect(await vault.folderId('p', false)).toBeNull()
  expect(readVault(sandbox).folders).toEqual([])
})

test('no secret value ever reaches argv', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const vault = await open(sandbox)
  const folderId = (await vault.folderId('p', true)) ?? ''
  await vault.createItem(folderId, 'p/A', 'A', 's3cret-value', '')
  const item = vault.findItem(await vault.items(folderId), 'p/A')
  if (!item) throw new Error('no item')
  await vault.updateValue(item, 's3cret-value-2')
  for (const call of readVault(sandbox).calls) {
    for (const arg of call.argv) expect(arg).not.toContain('s3cret')
    expect(call.argv).not.toContain('--session')
  }
})

test('duplicate names stop', async () => {
  const sandbox = makeSandbox(MANIFEST)
  seedItems(sandbox, 'p', { 'p/A': 'one' })
  seedItems(sandbox, 'p', { 'p/A': 'two' })
  const vault = await open(sandbox)
  const folderId = (await vault.folderId('p', false)) ?? ''
  const items = await vault.items(folderId)
  try {
    vault.findItem(items, 'p/A')
    throw new Error('expected a refusal')
  } catch (error) {
    expect(String(error)).toContain('2 items')
    expect(String(error)).toContain('p/A')
  }
})

test('every call carries --nointeraction --response', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const vault = await open(sandbox)
  const folderId = (await vault.folderId('p', true)) ?? ''
  await vault.items(folderId)
  for (const call of readVault(sandbox).calls) {
    expect(call.argv.slice(0, 2)).toEqual(['--nointeraction', '--response'])
  }
})
