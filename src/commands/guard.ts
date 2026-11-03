import type { ParsedArgs } from '../args'
import type { Context } from '../context'
import { BwenvError } from '../errors'
import { isSecretPath, judgeToolCall, type ToolCall } from '../guard'
import { readStream } from '../prompt'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolCallOf(text: string): ToolCall | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const { tool_name, tool_input, cwd } = raw
  if (typeof tool_name !== 'string' || !isRecord(tool_input)) return null
  const call: ToolCall = { tool_name, tool_input }
  if (typeof cwd === 'string' && cwd !== '') call.cwd = cwd
  return call
}

function guardContext(ctx: Context): {
  cwd: string
  home: string
  statePath: string
} {
  return { cwd: ctx.cwd, home: ctx.home, statePath: ctx.statePath }
}

export function runIsSecret(ctx: Context, args: ParsedArgs): Promise<number> {
  const [path, ...extra] = args.positionals
  if (path === undefined || extra.length > 0) {
    throw new BwenvError('bwenv is-secret takes exactly one path.', 2)
  }
  const secret = isSecretPath(path, guardContext(ctx))
  ctx.stdout.write(secret ? 'secret\n' : 'not secret\n')
  return Promise.resolve(secret ? 0 : 1)
}

export async function runHook(ctx: Context, args: ParsedArgs): Promise<number> {
  if (args.positionals.length !== 1 || args.positionals[0] !== 'claude') {
    throw new BwenvError('Use: bwenv hook claude', 2)
  }
  const call = toolCallOf(await readStream(ctx.stdin))
  if (call === null) {
    ctx.stderr.write('bwenv hook: unreadable input\n')
    return 0
  }
  const denial = judgeToolCall(call, guardContext(ctx))
  if (denial === null) return 0
  ctx.stderr.write(`${denial}\n`)
  return 2
}
