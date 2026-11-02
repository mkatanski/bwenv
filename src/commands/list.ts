import type { ParsedArgs } from '../args'
import type { Context } from '../context'
import { parseEnv } from '../dotenv'
import { BwenvError } from '../errors'
import { readText } from '../files'
import { groupByFile, type FileGroup } from '../groups'
import { loadManifest } from '../manifest'
import { loadState, type State } from '../state'

function describeGroup(group: FileGroup, state: State): string[] {
  const text = readText(group.path)
  const present = text === null ? new Map<string, string>() : parseEnv(text)
  const declared = new Set(group.variables.map(([name]) => name))
  const undeclared = [...present.keys()].filter((name) => !declared.has(name))
  const width = Math.max(
    ...group.variables.map(([name]) => name.length),
    ...undeclared.map((name) => name.length),
  )

  const environment = state[group.path]?.environment
  const lines = [
    environment === undefined
      ? group.file
      : `${group.file}  (last synced: ${environment})`,
  ]
  for (const [name, spec] of group.variables) {
    const label = name.padEnd(width)
    if (present.has(name)) lines.push(`  ${label}  set`)
    else if (spec.how === undefined) lines.push(`  ${label}  missing`)
    else lines.push(`  ${label}  missing — ${spec.how}`)
  }
  for (const name of undeclared) {
    lines.push(`  ${name.padEnd(width)}  set, not declared in bwenv.json`)
  }
  return lines
}

export function runList(ctx: Context, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) {
    throw new BwenvError(
      'bwenv list takes no names. Use --file to narrow it.',
      2,
    )
  }
  const loaded = loadManifest(ctx.cwd)
  const state = loadState(ctx.statePath)
  const blocks = groupByFile(loaded, ctx.home, args.flags.file).map((group) =>
    describeGroup(group, state).join('\n'),
  )
  ctx.stdout.write(`${blocks.join('\n\n')}\n`)
  return Promise.resolve(0)
}
