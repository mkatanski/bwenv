#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'

import type { FakeVault } from './helpers'

const GLOBAL_FLAGS = new Set([
  '--nointeraction',
  '--response',
  '--raw',
  '--pretty',
  '--quiet',
  '--cleanexit',
])

const vaultPath = process.env.BWENV_FAKE_VAULT ?? ''
const raw: unknown = JSON.parse(readFileSync(vaultPath, 'utf8'))
const vault = raw as FakeVault
const argv = process.argv.slice(2)
const args = argv.filter((arg) => !GLOBAL_FLAGS.has(arg))
const [command = '', object = '', id = ''] = args
const sessionOk = process.env.BW_SESSION === vault.session
const readsStdin =
  (command === 'create' || command === 'edit') && args.length <= 3
const stdin = readsStdin ? await Bun.stdin.text() : ''

vault.calls.push({ argv, stdin, sessionOk })

function finish(body: unknown, code: number): never {
  writeFileSync(vaultPath, JSON.stringify(vault, null, 2))
  process.stdout.write(JSON.stringify(body))
  process.exit(code)
}

function ok(data: unknown): never {
  finish({ success: true, data }, 0)
}

function fail(message: string): never {
  finish({ success: false, message }, 1)
}

function option(name: string): string | null {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? null)
}

function decoded(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(stdin, 'base64').toString())
  return parsed as Record<string, unknown>
}

if (command === 'status') {
  const status =
    vault.status === 'unauthenticated'
      ? 'unauthenticated'
      : sessionOk
        ? 'unlocked'
        : 'locked'
  ok({ object: 'template', template: { status } })
}
if (command === 'unlock') fail('fake bw: unlock needs a TTY')
if (vault.status === 'unauthenticated') fail('You are not logged in.')
if (!sessionOk) fail('Vault is locked.')

if (command === 'sync') ok({ object: 'message', title: 'Syncing complete.' })

if (command === 'list' && object === 'folders') {
  const search = option('--search') ?? ''
  ok({
    object: 'list',
    data: vault.folders.filter((folder) => folder.name.includes(search)),
  })
}

if (command === 'list' && object === 'items') {
  const folderId = option('--folderid')
  ok({
    object: 'list',
    data: vault.items.filter(
      (item) => item.folderId === folderId && !item.deletedDate,
    ),
  })
}

if (command === 'create' && object === 'folder') {
  const folder = { id: crypto.randomUUID(), name: String(decoded().name) }
  vault.folders.push(folder)
  ok({ object: 'folder', ...folder })
}

if (command === 'create' && object === 'item') {
  const item = { ...decoded(), id: crypto.randomUUID(), passwordHistory: null }
  vault.items.push(item)
  ok({ object: 'item', ...item })
}

if (command === 'edit' && object === 'item') {
  const index = vault.items.findIndex((item) => item.id === id)
  if (index === -1) fail('Not found.')
  const item = { ...decoded(), id }
  vault.items[index] = item
  ok({ object: 'item', ...item })
}

if (command === 'delete' && object === 'item') {
  const item = vault.items.find((candidate) => candidate.id === id)
  if (!item) fail('Not found.')
  item.deletedDate = new Date().toISOString()
  ok(null)
}

fail(`fake bw: unsupported command ${args.join(' ')}`)
