import type { ParsedArgs } from '../args'
import { openVault } from '../bitwarden'
import type { Context } from '../context'
import { BwenvError } from '../errors'
import { folderName } from '../manifest'
import { obtainValue } from '../value-source'
import { declaredTarget, envSuffix, writeLocal } from '../variable'

export async function runUpdate(
  ctx: Context,
  args: ParsedArgs,
): Promise<number> {
  const target = declaredTarget(ctx.cwd, ctx.home, args)
  const { name, spec } = target
  const project = target.loaded.manifest.project

  const vault = await openVault({
    env: ctx.env,
    isTTY: ctx.isTTY,
    ownerCommand: `bwenv update ${name}${envSuffix(target)}`,
    stderr: ctx.stderr,
  })
  const folderId = await vault.folderId(project, false)
  const items = folderId === null ? [] : await vault.items(folderId)
  const item = vault.findItem(items, target.item)
  if (item === null) {
    throw new BwenvError(
      `${name} is not in Bitwarden yet. Use: bwenv add ${name}${envSuffix(target)}`,
    )
  }

  const value = await obtainValue(ctx, name, args.flags.fromFile, target.path)
  await vault.updateValue(item, value)

  const vaultOnly = writeLocal(target, value, ctx.statePath)
  const where = folderName(project)
  ctx.stdout.write(
    vaultOnly === null
      ? `Updated ${name} in Bitwarden (${where}) and in ${spec.file}.\n`
      : `Updated ${name} in Bitwarden (${where}).\n${vaultOnly}\n`,
  )
  return 0
}
