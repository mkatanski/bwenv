import type { ParsedArgs } from '../args'
import { openVault } from '../bitwarden'
import type { Context } from '../context'
import { BwenvError } from '../errors'
import {
  folderName,
  loadManifest,
  saveManifest,
  type VariableSpec,
} from '../manifest'
import { obtainValue } from '../value-source'
import {
  assertFromFileMatches,
  envSuffix,
  singleName,
  targetOf,
  writeLocal,
} from '../variable'

function newSpec(args: ParsedArgs, name: string): VariableSpec {
  const { file, how, env } = args.flags
  if (file === undefined) {
    throw new BwenvError(
      `${name} is not declared in bwenv.json. Pass --file <path> to declare it.`,
      2,
    )
  }
  const spec: VariableSpec = { file }
  if (how !== undefined) spec.how = how
  if (env !== undefined) spec.perEnvironment = true
  return spec
}

function declaredSpec(
  args: ParsedArgs,
  name: string,
  declared: VariableSpec,
): VariableSpec {
  const { file, how } = args.flags
  if (file !== undefined && file !== declared.file) {
    throw new BwenvError(
      `${name} is declared for ${declared.file} in bwenv.json, not ${file}.`,
      2,
    )
  }
  if (how !== undefined) {
    throw new BwenvError(
      `--how only applies when declaring a new variable. Edit bwenv.json to change the hint for ${name}.`,
      2,
    )
  }
  return declared
}

export async function runAdd(ctx: Context, args: ParsedArgs): Promise<number> {
  const name = singleName(args)
  const loaded = loadManifest(ctx.cwd)
  const declared = loaded.manifest.variables[name]
  const spec =
    declared === undefined
      ? newSpec(args, name)
      : declaredSpec(args, name, declared)
  const target = targetOf(loaded, name, spec, args.flags.env, ctx.home)
  assertFromFileMatches(target, args.flags.fromFile, ctx.statePath)
  const project = loaded.manifest.project

  const vault = await openVault({
    env: ctx.env,
    isTTY: ctx.isTTY,
    ownerCommand: `bwenv add ${name}${envSuffix(target)}`,
    stderr: ctx.stderr,
  })
  const existingFolder = await vault.folderId(project, false)
  const items = existingFolder === null ? [] : await vault.items(existingFolder)
  if (vault.findItem(items, target.item) !== null) {
    throw new BwenvError(
      `${name} is already in Bitwarden. Use: bwenv update ${name}${envSuffix(target)}`,
    )
  }

  const value = await obtainValue(ctx, name, args.flags.fromFile, target.path)
  const folderId = existingFolder ?? (await vault.folderId(project, true)) ?? ''
  const managed = `Managed by bwenv · project ${project} · file ${spec.file}`
  await vault.createItem(
    folderId,
    target.item,
    name,
    value,
    spec.how === undefined ? managed : `${spec.how}\n\n${managed}`,
  )

  const vaultOnly = writeLocal(target, value, ctx.statePath)
  if (declared === undefined) {
    loaded.manifest.variables[name] = spec
    saveManifest(loaded)
  }

  const where = folderName(project)
  ctx.stdout.write(
    vaultOnly === null
      ? `Added ${name} to Bitwarden (${where}) and to ${spec.file}.\n`
      : `Added ${name} to Bitwarden (${where}).\n${vaultOnly}\n`,
  )
  return 0
}
