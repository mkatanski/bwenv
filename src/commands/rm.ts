import type { ParsedArgs } from '../args'
import { openVault, type VaultItem } from '../bitwarden'
import type { Context } from '../context'
import { ENV_PATTERN, parseEnv, removeKey } from '../dotenv'
import { BwenvError } from '../errors'
import { assertIgnoredIfInRepo, readText, writeSecretFile } from '../files'
import {
  itemName,
  loadManifest,
  resolveFile,
  saveManifest,
  type LoadedManifest,
} from '../manifest'
import { confirm } from '../prompt'
import { forgetKey, loadState, saveState } from '../state'
import { checkEnvFlag, singleName } from '../variable'

function itemsOf(
  items: VaultItem[],
  project: string,
  name: string,
  onlyEnv: string | null,
): VaultItem[] {
  if (onlyEnv !== null) {
    const wanted = itemName(project, name, onlyEnv)
    return items.filter((item) => item.name === wanted)
  }
  return items.filter((item) => {
    const parts = item.name.split('/')
    if (parts.length === 2) return item.name === itemName(project, name, null)
    const [owner, env = '', variable] = parts
    return (
      parts.length === 3 &&
      owner === project &&
      variable === name &&
      ENV_PATTERN.test(env)
    )
  })
}

function forgetLocally(
  ctx: Context,
  loaded: LoadedManifest,
  name: string,
  file: string,
): void {
  const path = resolveFile(loaded, file, ctx.home)
  const text = readText(path)
  if (text !== null && parseEnv(text).has(name)) {
    assertIgnoredIfInRepo(path)
    writeSecretFile(path, removeKey(text, name))
  }
  const state = loadState(ctx.statePath)
  forgetKey(state, path, name)
  saveState(ctx.statePath, state)
  loaded.manifest.variables = Object.fromEntries(
    Object.entries(loaded.manifest.variables).filter(
      ([declared]) => declared !== name,
    ),
  )
  saveManifest(loaded)
}

export async function runRm(ctx: Context, args: ParsedArgs): Promise<number> {
  const name = singleName(args)
  const loaded = loadManifest(ctx.cwd)
  const spec = loaded.manifest.variables[name]
  if (spec === undefined) {
    throw new BwenvError(`${name} is not declared in bwenv.json.`, 2)
  }
  checkEnvFlag(name, spec, args.flags.env)
  const onlyEnv = args.flags.env ?? null
  const scope =
    onlyEnv === null
      ? `${name} from bwenv.json, ${spec.file} and Bitwarden`
      : `${name} for ${onlyEnv} from Bitwarden`

  if (!args.flags.yes) {
    if (!ctx.isTTY) {
      throw new BwenvError(`Pass --yes to remove ${name} without a prompt.`, 2)
    }
    if (!(await confirm(`Remove ${scope}?`, ctx))) {
      ctx.stdout.write('Nothing was removed.\n')
      return 1
    }
  }

  const project = loaded.manifest.project
  const vault = await openVault({
    env: ctx.env,
    isTTY: ctx.isTTY,
    ownerCommand: `bwenv rm ${name}${onlyEnv === null ? '' : ` --env ${onlyEnv}`}`,
    stderr: ctx.stderr,
  })
  const folderId = await vault.folderId(project, false)
  const doomed = itemsOf(
    folderId === null ? [] : await vault.items(folderId),
    project,
    name,
    onlyEnv,
  )
  for (const item of doomed) await vault.deleteItem(item.id)

  if (onlyEnv === null) forgetLocally(ctx, loaded, name, spec.file)

  const removed = onlyEnv === null ? name : `${name} for ${onlyEnv}`
  ctx.stdout.write(
    doomed.length === 0
      ? `Removed ${removed}. There was nothing in Bitwarden to delete.\n`
      : `Removed ${removed}. Bitwarden keeps deleted items in its trash for 30 days.\n`,
  )
  return 0
}
