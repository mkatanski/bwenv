import { expect, test } from 'bun:test'

import {
  checkName,
  checkValue,
  parseEnv,
  removeKey,
  setKey,
} from '../src/dotenv'
import { BwenvError } from '../src/errors'

function thrown(fn: () => void): BwenvError {
  try {
    fn()
  } catch (error) {
    if (error instanceof BwenvError) return error
    throw error
  }
  throw new Error('expected a BwenvError, nothing was thrown')
}

test('parseEnv reads plain and export lines, last occurrence wins, skips comments', () => {
  const env = parseEnv('# c\nA=1\nexport B=two\n\nA=3\r\n')
  expect([...env]).toEqual([
    ['A', '3'],
    ['B', 'two'],
  ])
})

test('setKey replaces in place, keeps export prefix and other lines byte for byte', () => {
  expect(setKey('# keep\nexport A=old\nB=2\n', 'A', 'new')).toBe(
    '# keep\nexport A=new\nB=2\n',
  )
})

test('setKey keeps CRLF and drops later duplicates', () => {
  expect(setKey('A=1\r\nB=2\r\nA=3\r\n', 'A', 'x')).toBe('A=x\r\nB=2\r\n')
})

test('setKey appends with a newline when the file lacks one', () => {
  expect(setKey('A=1', 'B', '2')).toBe('A=1\nB=2\n')
  expect(setKey('', 'B', '2')).toBe('B=2\n')
})

test('setKey does not touch a key that only shares a prefix', () => {
  expect(setKey('AB=1\n', 'A', '2')).toBe('AB=1\nA=2\n')
})

test('removeKey removes every occurrence and nothing else', () => {
  expect(removeKey('A=1\nB=2\nA=3\n', 'A')).toBe('B=2\n')
})

test('checkValue refuses empty and unsafe values without echoing them', () => {
  expect(
    thrown(() => {
      checkValue('TOKEN', '')
    }).message,
  ).toContain('TOKEN is empty')
  const unsafe = thrown(() => {
    checkValue('TOKEN', 'se cret"$')
  })
  expect(unsafe.exitCode).toBe(2)
  expect(unsafe.message).toContain('TOKEN')
  expect(unsafe.message).not.toContain('se cret')
  expect(() => {
    checkValue('MAIL', 'a+b@x.io')
  }).not.toThrow()
})

test('checkName refuses lower case and leading digits', () => {
  expect(
    thrown(() => {
      checkName('api_key')
    }).exitCode,
  ).toBe(2)
  expect(
    thrown(() => {
      checkName('1KEY')
    }).exitCode,
  ).toBe(2)
  expect(() => {
    checkName('API_KEY_2')
  }).not.toThrow()
})
