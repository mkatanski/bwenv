import type { Readable } from 'node:stream'

import type { Context } from './context'
import { BwenvError } from './errors'

type PromptContext = Pick<Context, 'isTTY' | 'stdin' | 'stderr'>

interface RawStream extends Readable {
  setRawMode(mode: boolean): unknown
}

function isRawStream(stream: Readable): stream is RawStream {
  return 'setRawMode' in stream && typeof stream.setRawMode === 'function'
}

const ENTER = new Set(['\r', '\n'])
const CTRL_C = '\u0003'
const BACKSPACE = new Set(['\u007f', '\b'])

async function readAll(stream: Readable): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') text += chunk
    else if (chunk instanceof Uint8Array) {
      text += decoder.decode(chunk, { stream: true })
    }
  }
  return text + decoder.decode()
}

function hiddenPrompt(
  label: string,
  stdin: RawStream,
  stderr: PromptContext['stderr'],
): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = (): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stderr.write('\n')
    }
    const onData = (data: Buffer | string): void => {
      for (const char of data.toString()) {
        if (ENTER.has(char)) {
          finish()
          resolve(value)
          return
        }
        if (char === CTRL_C) {
          finish()
          reject(new BwenvError('Cancelled. Nothing was written.'))
          return
        }
        if (BACKSPACE.has(char)) value = value.slice(0, -1)
        else if (char >= ' ') value += char
      }
    }
    stderr.write(`${label}: `)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}

export async function readValue(
  label: string,
  ctx: PromptContext,
): Promise<string> {
  if (ctx.isTTY && isRawStream(ctx.stdin)) {
    return hiddenPrompt(label, ctx.stdin, ctx.stderr)
  }
  const text = await readAll(ctx.stdin)
  return text.replace(/\r?\n$/, '')
}

function readLine(stdin: Readable): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    const done = (line: string): void => {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.pause()
      resolve(line)
    }
    const onData = (data: Buffer | string): void => {
      text += data.toString()
      const newline = text.indexOf('\n')
      if (newline !== -1) done(text.slice(0, newline))
    }
    const onEnd = (): void => {
      done(text)
    }
    stdin.on('data', onData)
    stdin.on('end', onEnd)
    stdin.resume()
  })
}

export async function confirm(
  question: string,
  ctx: Pick<Context, 'stdin' | 'stderr'>,
): Promise<boolean> {
  ctx.stderr.write(`${question} [y/N] `)
  const answer = await readLine(ctx.stdin)
  return /^y(es)?$/i.test(answer.trim())
}
