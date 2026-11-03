#!/usr/bin/env bun
import { parseArgs, USAGE, type ParsedArgs } from './args'
import { runList } from './commands/list'
import { runSync } from './commands/sync'
import { contextFromProcess, type Context } from './context'
import { BwenvError } from './errors'

type Handler = (ctx: Context, args: ParsedArgs) => Promise<number>

function notImplemented(): Promise<number> {
  throw new BwenvError('not implemented yet', 2)
}

function help(ctx: Context): Promise<number> {
  ctx.stdout.write(`${USAGE}\n`)
  return Promise.resolve(0)
}

const HANDLERS = new Map<string, Handler>([
  ['sync', runSync],
  ['add', notImplemented],
  ['update', notImplemented],
  ['rm', notImplemented],
  ['list', runList],
  ['is-secret', notImplemented],
  ['hook', notImplemented],
  ['help', help],
])

async function main(): Promise<number> {
  const ctx = contextFromProcess()
  try {
    const args = parseArgs(process.argv.slice(2))
    const handler = HANDLERS.get(args.command) ?? help
    return await handler(ctx, args)
  } catch (error) {
    if (error instanceof BwenvError) {
      ctx.stderr.write(`${error.message}\n`)
      return error.exitCode
    }
    const reason = error instanceof Error ? error.message : String(error)
    ctx.stderr.write(`bwenv failed unexpectedly: ${reason}\n`)
    return 1
  }
}

process.exitCode = await main()
