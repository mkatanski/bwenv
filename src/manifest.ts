import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { ENV_PATTERN, NAME_PATTERN } from './dotenv'
import { BwenvError } from './errors'

export const MANIFEST_NAME = 'bwenv.json'
const DEFAULT_ENVIRONMENT = 'local'

export interface VariableSpec {
  file: string
  how?: string
  perEnvironment?: boolean
}

export interface Manifest {
  project: string
  defaultEnvironment?: string
  variables: Record<string, VariableSpec>
}

export interface LoadedManifest {
  path: string
  dir: string
  manifest: Manifest
}

const TOP_LEVEL_KEYS = new Set(['project', 'defaultEnvironment', 'variables'])
const VARIABLE_KEYS = new Set(['file', 'how', 'perEnvironment'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(path: string, field: string, problem: string): BwenvError {
  return new BwenvError(`${path}: ${field} ${problem}`, 2)
}

function rejectUnknownKeys(
  path: string,
  record: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw invalid(
        path,
        `${prefix}${key}`,
        `is not a field bwenv knows. Allowed: ${[...allowed].join(', ')}.`,
      )
    }
  }
}

function parseVariable(path: string, name: string, raw: unknown): VariableSpec {
  const field = `variables.${name}`
  if (!NAME_PATTERN.test(name)) {
    throw invalid(
      path,
      field,
      'is not a valid variable name. Use capital letters, digits and _, not starting with a digit.',
    )
  }
  if (!isRecord(raw)) throw invalid(path, field, 'must be an object.')
  rejectUnknownKeys(path, raw, VARIABLE_KEYS, `${field}.`)

  const { file, how, perEnvironment } = raw
  if (typeof file !== 'string' || file === '') {
    throw invalid(path, `${field}.file`, 'must be a non-empty string.')
  }
  const spec: VariableSpec = { file }
  if (how !== undefined) {
    if (typeof how !== 'string') {
      throw invalid(path, `${field}.how`, 'must be a string.')
    }
    spec.how = how
  }
  if (perEnvironment !== undefined) {
    if (typeof perEnvironment !== 'boolean') {
      throw invalid(path, `${field}.perEnvironment`, 'must be true or false.')
    }
    spec.perEnvironment = perEnvironment
  }
  return spec
}

export function parseManifest(text: string, path: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new BwenvError(`${path} is not valid JSON: ${reason}`, 2)
  }
  if (!isRecord(raw)) throw invalid(path, 'the top level', 'must be an object.')
  rejectUnknownKeys(path, raw, TOP_LEVEL_KEYS, '')

  const { project, defaultEnvironment, variables } = raw
  if (typeof project !== 'string' || !ENV_PATTERN.test(project)) {
    throw invalid(
      path,
      'project',
      'must be lower case letters, digits and -, for example "my-app".',
    )
  }
  const manifest: Manifest = { project, variables: {} }
  if (defaultEnvironment !== undefined) {
    if (
      typeof defaultEnvironment !== 'string' ||
      !ENV_PATTERN.test(defaultEnvironment)
    ) {
      throw invalid(
        path,
        'defaultEnvironment',
        'must be lower case letters, digits and -, for example "local".',
      )
    }
    manifest.defaultEnvironment = defaultEnvironment
  }
  if (!isRecord(variables)) {
    throw invalid(path, 'variables', 'must be an object.')
  }
  for (const [name, spec] of Object.entries(variables)) {
    manifest.variables[name] = parseVariable(path, name, spec)
  }
  return manifest
}

export function findManifest(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    const candidate = join(dir, MANIFEST_NAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function loadManifest(startDir: string): LoadedManifest {
  const path = findManifest(startDir)
  if (path === null) {
    throw new BwenvError(
      `No ${MANIFEST_NAME} in ${startDir} or any parent directory.`,
      2,
    )
  }
  return {
    path,
    dir: dirname(path),
    manifest: parseManifest(readFileSync(path, 'utf8'), path),
  }
}

export function saveManifest(loaded: LoadedManifest): void {
  writeFileSync(loaded.path, `${JSON.stringify(loaded.manifest, null, 2)}\n`)
}

export function defaultEnvironment(manifest: Manifest): string {
  return manifest.defaultEnvironment ?? DEFAULT_ENVIRONMENT
}

export function resolveFile(
  loaded: LoadedManifest,
  file: string,
  home: string,
): string {
  if (file.startsWith('~/')) return join(home, file.slice(2))
  if (isAbsolute(file)) {
    throw new BwenvError(
      `${file} is an absolute path, which ties ${MANIFEST_NAME} to one machine. Use ~/… or a path relative to ${loaded.path}.`,
      2,
    )
  }
  return resolve(loaded.dir, file)
}

export function itemName(
  project: string,
  name: string,
  env: string | null,
): string {
  return env === null ? `${project}/${name}` : `${project}/${env}/${name}`
}

export function folderName(project: string): string {
  return `bwenv/${project}`
}
