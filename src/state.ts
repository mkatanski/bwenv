import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { BwenvError } from './errors'
import { readText, writeSecretFile } from './files'

export interface FileState {
  project: string
  environment: string
  values: Record<string, string>
}

export type State = Record<string, FileState>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileState(value: unknown): value is FileState {
  return (
    isRecord(value) &&
    typeof value.project === 'string' &&
    typeof value.environment === 'string' &&
    isRecord(value.values) &&
    Object.values(value.values).every((hash) => typeof hash === 'string')
  )
}

export function statePath(
  env: Record<string, string | undefined>,
  home: string,
): string {
  const base =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ''
      ? env.XDG_STATE_HOME
      : join(home, '.local', 'state')
  return join(base, 'bwenv', 'state.json')
}

export function loadState(path: string): State {
  const text = readText(path)
  if (text === null) return {}
  const damaged = new BwenvError(
    `The bwenv state file ${path} is damaged. Delete it; the next sync rebuilds it.`,
  )
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw damaged
  }
  if (!isRecord(raw)) throw damaged
  const state: State = {}
  for (const [file, entry] of Object.entries(raw)) {
    if (!isFileState(entry)) throw damaged
    state[file] = entry
  }
  return state
}

export function saveState(path: string, state: State): void {
  writeSecretFile(path, `${JSON.stringify(state, null, 2)}\n`)
}

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function recordValues(
  state: State,
  file: string,
  project: string,
  environment: string,
  values: Record<string, string>,
): void {
  const entry = state[file] ?? { project, environment, values: {} }
  entry.project = project
  entry.environment = environment
  for (const [key, value] of Object.entries(values)) {
    entry.values[key] = hashValue(value)
  }
  state[file] = entry
}

export function forgetKey(state: State, file: string, key: string): void {
  const entry = state[file]
  if (!entry) return
  entry.values = Object.fromEntries(
    Object.entries(entry.values).filter(([name]) => name !== key),
  )
}

export function fileHoldsEnvironment(
  state: State,
  file: string,
  env: string,
  defaultEnv: string,
): boolean {
  const entry = state[file]
  return entry ? entry.environment === env : env === defaultEnv
}
