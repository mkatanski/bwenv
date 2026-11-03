import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

import { BwenvError } from './errors'
import { findManifest, parseManifest, resolveFile } from './manifest'
import { readText } from './files'
import { loadState } from './state'

export interface GuardContext {
  cwd: string
  home: string
  statePath: string
}

export interface ToolCall {
  tool_name: string
  tool_input: Record<string, unknown>
  cwd?: string
}

const READERS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'rg',
  'ag',
  'sed',
  'awk',
  'cut',
  'sort',
  'uniq',
  'diff',
  'cmp',
  'bat',
  'xxd',
  'od',
  'hexdump',
  'strings',
  'base64',
  'cp',
  'mv',
  'tee',
  'jq',
  'vi',
  'vim',
  'nvim',
  'nano',
  'code',
  'open',
  'pbcopy',
])

const WRAPPERS = new Set([
  'sudo',
  'env',
  'command',
  'exec',
  'time',
  'nice',
  'nohup',
])

const AGENTS_NO_BW =
  'Agents do not use the Bitwarden CLI. Ask the owner, or use: bwenv list'

function isBuiltInSecretName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === '.env.example') return false
  return (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower === '.dev.vars' ||
    lower.startsWith('.dev.vars.')
  )
}

function globTargetsSecrets(glob: string): boolean {
  const last = glob.split('/').at(-1) ?? glob
  return isBuiltInSecretName(last.replaceAll('*', '.x'))
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

function canonical(path: string): string {
  let existing = path
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return path
    existing = parent
  }
  try {
    return join(realpathSync(existing), relative(existing, path))
  } catch {
    return path
  }
}

function manifestFiles(manifestPath: string | null, home: string): string[] {
  if (manifestPath === null) return []
  try {
    const manifest = parseManifest(readText(manifestPath) ?? '', manifestPath)
    const loaded = { path: manifestPath, dir: dirname(manifestPath), manifest }
    return Object.values(manifest.variables).flatMap((spec) => {
      try {
        return [canonical(resolveFile(loaded, spec.file, home))]
      } catch (error) {
        if (error instanceof BwenvError) return []
        throw error
      }
    })
  } catch (error) {
    if (error instanceof BwenvError) return []
    throw error
  }
}

function stateFiles(statePath: string): string[] {
  try {
    return Object.keys(loadState(statePath)).map(canonical)
  } catch (error) {
    if (error instanceof BwenvError) return []
    throw error
  }
}

export function isSecretPath(path: string, ctx: GuardContext): boolean {
  const expanded = expandHome(path, ctx.home)
  const absolute = isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded)
  const target = canonical(absolute)
  if (isBuiltInSecretName(basename(absolute))) return true
  if (isBuiltInSecretName(basename(target))) return true

  const known = [
    ...stateFiles(ctx.statePath),
    ...manifestFiles(findManifest(ctx.cwd), ctx.home),
    ...manifestFiles(findManifest(dirname(absolute)), ctx.home),
  ]
  return known.includes(target)
}

interface Segment {
  words: string[]
  redirects: string[]
}

function tokenize(command: string): Segment[] {
  const segments: Segment[] = []
  let segment: Segment = { words: [], redirects: [] }
  let word: string | null = null
  let quote: '"' | "'" | null = null
  let redirectNext = false

  const endWord = (): void => {
    if (word === null) return
    if (redirectNext) {
      segment.redirects.push(word)
      redirectNext = false
    } else {
      segment.words.push(word)
    }
    word = null
  }
  const endSegment = (): void => {
    endWord()
    if (segment.words.length > 0 || segment.redirects.length > 0) {
      segments.push(segment)
    }
    segment = { words: [], redirects: [] }
  }

  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (quote !== null) {
      if (char === quote) quote = null
      else word = (word ?? '') + char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      word ??= ''
    } else if (char === ' ' || char === '\t') {
      endWord()
    } else if (char === '\n' || char === ';' || char === '|' || char === '&') {
      endSegment()
    } else if (char === '<' || char === '>') {
      if (word !== null && /^\d+$/.test(word)) word = null
      endWord()
      redirectNext = true
      while (command.charAt(index + 1) === '>') index++
    } else {
      word = (word ?? '') + char
    }
  }
  endSegment()
  return segments
}

function expandWord(word: string, home: string): string {
  return expandHome(
    word.replaceAll('${HOME}', home).replace(/\$HOME(?![A-Za-z0-9_])/g, home),
    home,
  )
}

function commandIndex(words: string[]): number {
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word)) index++
    else break
  }
  return index
}

function secretDenial(path: string): string {
  return `${path} holds secrets. Use: bwenv list (names only, no values)`
}

const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rgrep'])
const RIPGREPS = new Set(['rg', 'ag'])
const UNRESTRICTED = new Set([
  '--hidden',
  '--no-ignore',
  '--unrestricted',
  '--skip-vcs-ignores',
])
const PATTERN_VALUE = new Set(['-e', '--regexp'])
const FILE_VALUE = new Set(['-f', '--file'])
const OTHER_VALUE: Record<string, ReadonlySet<string>> = {
  grep: new Set(['-m', '-A', '-B', '-C', '-d', '-D']),
  rg: new Set(['-m', '-A', '-B', '-C', '-g', '-t', '-T', '-r', '-M', '-j']),
}
const WALK_SKIP = new Set(['node_modules', '.git'])
const WALK_DEPTH = 6
const WALK_LIMIT = 5000

interface Search {
  checked: string[]
  dirs: string[]
  readsEverything: boolean
}

function isShortCluster(arg: string): boolean {
  return /^-[A-Za-z.]+$/.test(arg)
}

function readsHiddenAndIgnored(command: string, option: string): boolean {
  if (GREP_FAMILY.has(command)) {
    return (
      option === '--recursive' ||
      option === '--dereference-recursive' ||
      (isShortCluster(option) && /[rR]/.test(option))
    )
  }
  return (
    UNRESTRICTED.has(option) || (isShortCluster(option) && /[uU.]/.test(option))
  )
}

function parseSearch(command: string, args: string[]): Search {
  const modelled = command !== 'ag'
  const otherValue =
    OTHER_VALUE[GREP_FAMILY.has(command) ? 'grep' : 'rg'] ?? new Set<string>()
  let readsEverything = command === 'rgrep'
  let patternInOption = !modelled
  const positionals: string[] = []
  const checked: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const option = equals === -1 ? arg : arg.slice(0, equals)
    if (readsHiddenAndIgnored(command, option)) readsEverything = true
    if (!modelled) continue
    if (equals !== -1) {
      if (!PATTERN_VALUE.has(option)) checked.push(arg.slice(equals + 1))
      if (PATTERN_VALUE.has(option) || FILE_VALUE.has(option)) {
        patternInOption = true
      }
      continue
    }
    if (PATTERN_VALUE.has(arg)) {
      patternInOption = true
      index++
    } else if (FILE_VALUE.has(arg) || otherValue.has(arg)) {
      if (FILE_VALUE.has(arg)) patternInOption = true
      checked.push(args[index + 1] ?? '')
      index++
    } else if (!arg.startsWith('--')) {
      if (/[ef]/.test(arg)) patternInOption = true
      checked.push(arg.slice(2))
    }
  }
  const dirs = patternInOption ? positionals : positionals.slice(1)
  return { checked: [...dirs, ...checked], dirs, readsEverything }
}

function isInsideDir(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  )
}

function isVisibleFrom(parent: string, child: string): boolean {
  return relative(parent, child)
    .split(sep)
    .every((segment) => !segment.startsWith('.'))
}

function treeHasBuiltInSecret(root: string): boolean {
  let seen = 0
  const stack: [string, number][] = [[root, 0]]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [dir, depth] = next
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen++
      if (seen > WALK_LIMIT || isBuiltInSecretName(entry.name)) return true
      if (
        entry.isDirectory() &&
        !WALK_SKIP.has(entry.name) &&
        depth < WALK_DEPTH
      ) {
        stack.push([join(dir, entry.name), depth + 1])
      }
    }
  }
  return false
}

function dirHoldsSecrets(
  dir: string,
  ctx: GuardContext,
  everything: boolean,
): boolean {
  const absolute = canonical(isAbsolute(dir) ? dir : resolve(ctx.cwd, dir))
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return false
  const known = [
    ...stateFiles(ctx.statePath),
    ...manifestFiles(findManifest(ctx.cwd), ctx.home),
    ...manifestFiles(findManifest(absolute), ctx.home),
  ].filter((path) => isInsideDir(absolute, path))
  if (!everything) return known.some((path) => isVisibleFrom(absolute, path))
  return known.length > 0 || treeHasBuiltInSecret(absolute)
}

function judgeSearch(
  command: string,
  args: string[],
  ctx: GuardContext,
): string | null {
  const { checked, dirs, readsEverything } = parseSearch(command, args)
  for (const word of checked) {
    if (word !== '' && isSecretPath(expandWord(word, ctx.home), ctx)) {
      return secretDenial(word)
    }
  }
  const recursive = readsEverything || RIPGREPS.has(command)
  if (!recursive) return null
  for (const dir of dirs.length === 0 ? ['.'] : dirs) {
    if (dirHoldsSecrets(expandWord(dir, ctx.home), ctx, readsEverything)) {
      return `${dir} holds secret files and this search would print them. Use: git grep (it skips ignored files), or bwenv list`
    }
  }
  return null
}

export function judgeBash(command: string, ctx: GuardContext): string | null {
  for (const segment of tokenize(command)) {
    for (const target of segment.redirects) {
      if (isSecretPath(expandWord(target, ctx.home), ctx)) {
        return secretDenial(target)
      }
    }
    const start = commandIndex(segment.words)
    const name = basename(segment.words[start] ?? '')
    if (name === 'bw') return AGENTS_NO_BW
    if (GREP_FAMILY.has(name) || RIPGREPS.has(name)) {
      const denial = judgeSearch(name, segment.words.slice(start + 1), ctx)
      if (denial !== null) return denial
      continue
    }
    if (!READERS.has(name)) continue
    for (const arg of segment.words.slice(start + 1)) {
      const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
      const value = equals === -1 ? arg : arg.slice(equals + 1)
      if (value === '' || value.startsWith('-')) continue
      if (isSecretPath(expandWord(value, ctx.home), ctx)) {
        return secretDenial(value)
      }
    }
  }
  return null
}

function pathField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value !== '' ? value : null
}

export function judgeToolCall(
  call: ToolCall,
  ctx: GuardContext,
): string | null {
  const guard = { ...ctx, cwd: call.cwd ?? ctx.cwd }
  const input = call.tool_input
  let path: string | null
  switch (call.tool_name) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      path = pathField(input, 'file_path')
      break
    case 'NotebookEdit':
      path = pathField(input, 'notebook_path')
      break
    case 'Grep': {
      const glob = pathField(input, 'glob')
      if (glob !== null && globTargetsSecrets(glob)) return secretDenial(glob)
      path = pathField(input, 'path')
      break
    }
    case 'Bash': {
      const command = pathField(input, 'command')
      return command === null ? null : judgeBash(command, guard)
    }
    default:
      return null
  }
  return path !== null && isSecretPath(path, guard) ? secretDenial(path) : null
}
