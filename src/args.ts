import { BwenvError } from './errors'

export const USAGE = `Usage:
  bwenv sync [--env <name>] [--file <path>] [--force]
  bwenv add <NAME> [--file <path>] [--env <name>] [--from-file] [--how <text>]
  bwenv update <NAME> [--env <name>] [--from-file]
  bwenv rm <NAME> [--env <name>] [--yes]
  bwenv list [--file <path>] [--vault]
  bwenv is-secret <path>
  bwenv hook claude
  bwenv help`

export interface Flags {
  env?: string
  file?: string
  how?: string
  force: boolean
  fromFile: boolean
  vault: boolean
  yes: boolean
}

export interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Flags
}

type ValueFlag = 'env' | 'file' | 'how'
type BooleanFlag = 'force' | 'fromFile' | 'vault' | 'yes'

const VALUE_FLAGS = new Map<string, ValueFlag>([
  ['--env', 'env'],
  ['--file', 'file'],
  ['--how', 'how'],
])

const BOOLEAN_FLAGS = new Map<string, BooleanFlag>([
  ['--force', 'force'],
  ['--from-file', 'fromFile'],
  ['--vault', 'vault'],
  ['--yes', 'yes'],
])

const ALLOWED = new Map<string, ReadonlySet<string>>([
  ['sync', new Set(['--env', '--file', '--force'])],
  ['add', new Set(['--file', '--env', '--from-file', '--how'])],
  ['update', new Set(['--env', '--from-file'])],
  ['rm', new Set(['--env', '--yes'])],
  ['list', new Set(['--file', '--vault'])],
  ['is-secret', new Set()],
  ['hook', new Set()],
  ['help', new Set()],
])

function usage(problem: string): BwenvError {
  return new BwenvError(`${problem}\n\n${USAGE}`, 2)
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv
  const allowed = ALLOWED.get(command)
  if (allowed === undefined) throw usage(`Unknown command "${command}".`)

  const flags: Flags = {
    force: false,
    fromFile: false,
    vault: false,
    yes: false,
  }
  const positionals: string[] = []

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] ?? ''
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (!allowed.has(name)) {
      throw usage(`bwenv ${command} does not take ${name}.`)
    }
    const valueFlag = VALUE_FLAGS.get(name)
    const booleanFlag = BOOLEAN_FLAGS.get(name)
    if (valueFlag !== undefined) {
      const value = equals === -1 ? rest[++index] : arg.slice(equals + 1)
      if (value === undefined || value === '') {
        throw usage(`${name} needs a value.`)
      }
      flags[valueFlag] = value
    } else if (booleanFlag !== undefined) {
      if (equals !== -1) throw usage(`${name} takes no value.`)
      flags[booleanFlag] = true
    }
  }

  return { command, positionals, flags }
}
