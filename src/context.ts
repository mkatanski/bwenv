import { homedir } from 'node:os'
import type { Readable } from 'node:stream'

import { statePath } from './state'

export interface Writer {
  write(text: string): unknown
}

export interface Context {
  cwd: string
  home: string
  env: Record<string, string | undefined>
  isTTY: boolean
  stdin: Readable
  stdout: Writer
  stderr: Writer
  statePath: string
}

export function contextFromProcess(): Context {
  const home = homedir()
  return {
    cwd: process.cwd(),
    home,
    env: process.env,
    isTTY: process.stdin.isTTY,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    statePath: statePath(process.env, home),
  }
}
