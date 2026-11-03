import type { ParsedArgs } from '../args'
import { openVault, type VaultItem } from '../bitwarden'
import type { Context } from '../context'
import { parseEnv } from '../dotenv'
import { BwenvError } from '../errors'
import { readText } from '../files'
import { groupByFile, type FileGroup } from '../groups'
import {
  defaultEnvironment,
  itemName,
  loadManifest,
  type LoadedManifest,
  type VariableSpec,
} from '../manifest'
import { fileFlag } from '../shell'
import { loadState, type State } from '../state'

type Lookup = (
  name: string,
  spec: VariableSpec,
  path: string,
) => VaultItem | null

function vaultColumn(
  local: string | undefined,
  item: VaultItem | null,
): string {
  if (local === undefined) return item === null ? 'not in vault' : 'in vault'
  if (item?.value == null) return 'not in vault'
  return item.value === local ? 'same' : 'differs'
}

function describeGroup(
  group: FileGroup,
  state: State,
  lookup: Lookup | null,
): string[] {
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
    const local = present.get(name)
    let row =
      local !== undefined
        ? 'set'
        : spec.how === undefined
          ? 'missing'
          : `missing — ${spec.how}`
    if (lookup !== null) {
      row += ` · ${vaultColumn(local, lookup(name, spec, group.path))}`
    }
    lines.push(`  ${name.padEnd(width)}  ${row}`)
  }
  for (const name of undeclared) {
    lines.push(`  ${name.padEnd(width)}  set, not declared in bwenv.json`)
  }
  return lines
}

async function vaultLookup(
  ctx: Context,
  args: ParsedArgs,
  loaded: LoadedManifest,
  state: State,
  groups: FileGroup[],
): Promise<Lookup> {
  const vault = await openVault({
    env: ctx.env,
    isTTY: ctx.isTTY,
    ownerCommand: `bwenv list --vault${fileFlag(args.flags.file, groups)}`,
    stderr: ctx.stderr,
  })
  const { project } = loaded.manifest
  const folderId = await vault.folderId(project, false)
  const items = folderId === null ? [] : await vault.items(folderId)
  const defaultEnv = defaultEnvironment(loaded.manifest)
  return (name, spec, path) => {
    const env =
      spec.perEnvironment === true
        ? (state[path]?.environment ?? defaultEnv)
        : null
    return vault.findItem(items, itemName(project, name, env))
  }
}

export async function runList(ctx: Context, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) {
    throw new BwenvError(
      'bwenv list takes no names. Use --file to narrow it.',
      2,
    )
  }
  const loaded = loadManifest(ctx.cwd)
  const state = loadState(ctx.statePath)
  const groups = groupByFile(loaded, ctx.home, args.flags.file)
  const lookup = args.flags.vault
    ? await vaultLookup(ctx, args, loaded, state, groups)
    : null
  const blocks = groups.map((group) =>
    describeGroup(group, state, lookup).join('\n'),
  )
  ctx.stdout.write(`${blocks.join('\n\n')}\n`)
  return 0
}
