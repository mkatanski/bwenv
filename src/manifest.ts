import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f)
}

function hasControl(text: string): boolean {
  return Array.from(text).some(isControl)
}

function printable(text: string): string {
  return Array.from(text)
    .map((char) => (isControl(char) ? '?' : char))
    .join('')
}

function invalid(path: string, field: string, problem: string): BwenvError {
  return new BwenvError(printable(`${path}: ${field} ${problem}`), 2)
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
  if (typeof file !== 'string' || file === '' || hasControl(file)) {
    throw invalid(
      path,
      `${field}.file`,
      'must be a non-empty string without control characters.',
    )
  }
  const spec: VariableSpec = { file }
  if (how !== undefined) {
    if (typeof how !== 'string' || hasControl(how)) {
      throw invalid(
        path,
        `${field}.how`,
        'must be a string without control characters.',
      )
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
    throw new BwenvError(printable(`${path} is not valid JSON: ${reason}`), 2)
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
  if (file.startsWith('~/')) {
    const inHome = resolve(home, file.slice(2))
    if (!isInside(home, inHome)) {
      throw new BwenvError(`${file} leaves the home directory.`, 2)
    }
    return inHome
  }
  if (isAbsolute(file)) {
    throw new BwenvError(
      `${file} is an absolute path, which ties ${MANIFEST_NAME} to one machine. Use ~/… or a path relative to ${loaded.path}.`,
      2,
    )
  }
  const inProject = resolve(loaded.dir, file)
  if (
    !isInside(loaded.dir, inProject) ||
    !isInside(realpathSync(loaded.dir), realPathOfNearest(inProject))
  ) {
    throw new BwenvError(
      `${file} leaves the directory of ${loaded.path}. A project file must stay inside the project; use ~/… for a file in the home directory.`,
      2,
    )
  }
  return inProject
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function realPathOfNearest(path: string): string {
  let existing = path
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  return join(realpathSync(existing), relative(existing, path))
}

export function fileFromCli(
  loaded: LoadedManifest,
  cliPath: string,
  cwd: string,
  home: string,
): { label: string; path: string } {
  const expanded =
    cliPath === '~'
      ? home
      : cliPath.startsWith('~/')
        ? join(home, cliPath.slice(2))
        : cliPath
  const absolute = resolve(cwd, expanded)
  let label: string
  if (isInside(loaded.dir, absolute)) {
    label = relative(loaded.dir, absolute).split(sep).join('/')
  } else if (isInside(home, absolute)) {
    label = `~/${relative(home, absolute).split(sep).join('/')}`
  } else {
    throw new BwenvError(
      `${cliPath} is outside both the project (${loaded.dir}) and the home directory.`,
      2,
    )
  }
  if (label === '' || label === '~/') {
    throw new BwenvError(`${cliPath} is a directory, not a file.`, 2)
  }
  return { label, path: resolveFile(loaded, label, home) }
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
