import { BwenvError } from './errors'

export const NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/
export const VALUE_PATTERN = /^[A-Za-z0-9_\-.:/@+=,%]+$/
export const ENV_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const ASSIGNMENT = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

interface Assignment {
  prefix: string
  key: string
  value: string
}

function assignment(line: string): Assignment | null {
  const match = ASSIGNMENT.exec(line)
  if (!match) return null
  const [, prefix = '', key = '', value = ''] = match
  return { prefix, key, value }
}

function lineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

function lines(text: string): string[] {
  if (text === '') return []
  const split = text.split(/\r?\n/)
  if (split.at(-1) === '') split.pop()
  return split
}

function join(out: string[], eol: string): string {
  return out.length === 0 ? '' : out.join(eol) + eol
}

export function parseEnv(text: string): Map<string, string> {
  const env = new Map<string, string>()
  for (const line of lines(text)) {
    const found = assignment(line)
    if (found) env.set(found.key, found.value)
  }
  return env
}

export function setKey(text: string, key: string, value: string): string {
  const out: string[] = []
  let written = false
  for (const line of lines(text)) {
    const found = assignment(line)
    if (found?.key !== key) {
      out.push(line)
      continue
    }
    if (!written) {
      out.push(`${found.prefix}${key}=${value}`)
      written = true
    }
  }
  if (!written) out.push(`${key}=${value}`)
  return join(out, lineEnding(text))
}

export function removeKey(text: string, key: string): string {
  const out = lines(text).filter((line) => assignment(line)?.key !== key)
  return join(out, lineEnding(text))
}

export function checkName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new BwenvError(
      `${name} is not a valid variable name. Use capital letters, digits and _, not starting with a digit.`,
      2,
    )
  }
}

export function checkValue(name: string, value: string): void {
  if (value === '') {
    throw new BwenvError(`${name} is empty. Nothing was written.`, 2)
  }
  if (!VALUE_PATTERN.test(value)) {
    throw new BwenvError(
      `${name} contains characters bwenv cannot store unquoted (allowed: letters, digits and _ - . : / @ + = , %). Nothing was written.`,
      2,
    )
  }
}
