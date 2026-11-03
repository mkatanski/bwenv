import { existsSync, realpathSync } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
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
  if (name === '.env.example') return false
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.dev.vars' ||
    name.startsWith('.dev.vars.')
  )
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
  if (isBuiltInSecretName(basename(absolute))) return true

  const target = canonical(absolute)
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
    case 'Write':
      path = pathField(input, 'file_path')
      break
    case 'NotebookEdit':
      path = pathField(input, 'notebook_path')
      break
    case 'Grep':
      path = pathField(input, 'path')
      break
    case 'Bash': {
      const command = pathField(input, 'command')
      return command === null ? null : judgeBash(command, guard)
    }
    default:
      return null
  }
  return path !== null && isSecretPath(path, guard) ? secretDenial(path) : null
}
