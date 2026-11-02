import { expect, test } from 'bun:test'

import { parseArgs, USAGE } from '../src/args'
import { BwenvError } from '../src/errors'

function usageError(argv: string[]): BwenvError {
  try {
    parseArgs(argv)
  } catch (error) {
    if (error instanceof BwenvError) return error
    throw error
  }
  throw new Error('expected a usage error')
}

test('add with an inline --file value and a boolean flag', () => {
  expect(parseArgs(['add', 'A', '--file=.env', '--from-file'])).toEqual({
    command: 'add',
    positionals: ['A'],
    flags: {
      file: '.env',
      force: false,
      fromFile: true,
      vault: false,
      yes: false,
    },
  })
})

test('sync with a separate --env value', () => {
  expect(parseArgs(['sync', '--env', 'staging']).flags.env).toBe('staging')
})

test('no arguments means help', () => {
  expect(parseArgs([]).command).toBe('help')
})

test('unknown flags, unknown commands and flags another command owns are usage errors', () => {
  for (const argv of [
    ['sync', '--bogus'],
    ['frobnicate'],
    ['constructor'],
    ['toString'],
    ['add', 'A', '--force'],
    ['sync', '--env'],
    ['list', '--vault=yes'],
  ]) {
    const error = usageError(argv)
    expect(error.exitCode).toBe(2)
    expect(error.message.endsWith(USAGE)).toBe(true)
  }
})
