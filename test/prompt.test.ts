import { expect, test } from 'bun:test'
import { Readable } from 'node:stream'

import { readValue } from '../src/prompt'

async function piped(text: string): Promise<string> {
  return readValue('Value for A', {
    isTTY: false,
    stdin: Readable.from([text]),
    stderr: { write: () => true },
  })
}

test('readValue strips one trailing newline from piped stdin', async () => {
  expect(await piped('tok\n')).toBe('tok')
  expect(await piped('tok\r\n')).toBe('tok')
  expect(await piped('tok')).toBe('tok')
  expect(await piped('tok\n\n')).toBe('tok\n')
})

test('readValue reads chunks as bytes too', async () => {
  const value = await readValue('Value for A', {
    isTTY: false,
    stdin: Readable.from([Buffer.from('to'), Buffer.from('k\n')]),
    stderr: { write: () => true },
  })
  expect(value).toBe('tok')
})
