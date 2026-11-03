import type { ParsedArgs } from '../args'
import { openVault, type Vault, type VaultItem } from '../bitwarden'
import type { Context } from '../context'
import { ENV_PATTERN, parseEnv, setKey, VALUE_PATTERN } from '../dotenv'
import { BwenvError } from '../errors'
import { assertIgnoredIfInRepo, readText, writeSecretFile } from '../files'
import { groupByFile, type FileGroup } from '../groups'
import {
  defaultEnvironment,
  itemName,
  loadManifest,
  type VariableSpec,
} from '../manifest'
import { loadState, recordValues, saveState, type State } from '../state'
import { fileFlag } from '../shell'
import { decideSync, type SyncOutcome } from '../sync-plan'

interface SyncRun {
  project: string
  env: string
  defaultEnv: string
  envFlag: string
  force: boolean
  vault: Vault
  items: VaultItem[]
  state: State
}

interface GroupResult {
  lines: string[]
  attention: boolean
}

function missingRow(name: string, spec: VariableSpec, run: SyncRun): string {
  const where =
    spec.perEnvironment === true
      ? `not in Bitwarden for ${run.env}`
      : 'not in Bitwarden'
  const how = spec.how === undefined ? '' : ` — ${spec.how}`
  const envFlag = spec.perEnvironment === true ? ` --env ${run.env}` : ''
  return `${where}${how}. Then: bwenv add ${name}${envFlag}`
}

function conflictRow(
  name: string,
  spec: VariableSpec,
  run: SyncRun,
  fileEnv: string,
): string {
  const keepEnv =
    spec.perEnvironment === true && fileEnv !== run.defaultEnv
      ? ` --env ${fileEnv}`
      : ''
  return `conflict — changed by hand since the last sync. Keep yours: bwenv update ${name} --from-file${keepEnv} · Take Bitwarden's: bwenv sync${run.envFlag} --force`
}

type Outcome = SyncOutcome | 'unwritable'

interface Planned {
  name: string
  spec: VariableSpec
  value: string | null
  outcome: Outcome
}

function plan(
  group: FileGroup,
  run: SyncRun,
  present: Map<string, string>,
): Planned[] {
  const recorded = run.state[group.path]?.values ?? {}
  return group.variables.map(([name, spec]) => {
    const item = run.vault.findItem(
      run.items,
      itemName(
        run.project,
        name,
        spec.perEnvironment === true ? run.env : null,
      ),
    )
    const value = item?.value ?? null
    const outcome: Outcome =
      value !== null && !VALUE_PATTERN.test(value)
        ? 'unwritable'
        : decideSync({
            local: present.get(name) ?? null,
            vault: value,
            lastWrittenHash: recorded[name] ?? null,
            force: run.force,
          })
    return { name, spec, value, outcome }
  })
}

function blocksSwitch(planned: Planned): boolean {
  return (
    planned.spec.perEnvironment === true &&
    (planned.outcome === 'missing' ||
      planned.outcome === 'conflict' ||
      planned.outcome === 'unwritable')
  )
}

function syncGroup(group: FileGroup, run: SyncRun): GroupResult {
  const lines = [`${group.file} (${run.env})`]
  try {
    assertIgnoredIfInRepo(group.path)
  } catch (error) {
    if (!(error instanceof BwenvError)) throw error
    lines.push(`  skipped — ${error.message}`)
    return { lines, attention: true }
  }

  const original = readText(group.path) ?? ''
  const planned = plan(group, run, parseEnv(original))
  const fileEnv = run.state[group.path]?.environment ?? run.defaultEnv
  const blocked = planned.some(blocksSwitch)
  const landed: Record<string, string> = {}
  const width = Math.max(...planned.map(({ name }) => name.length))
  let text = original
  let attention = false

  for (const { name, spec, value, outcome } of planned) {
    let row: string
    if (outcome === 'unwritable') {
      row =
        'stored in Bitwarden with characters bwenv cannot write unquoted. Fix the item in Bitwarden.'
      attention = true
    } else if (outcome === 'write' && value !== null) {
      if (blocked && spec.perEnvironment === true) {
        row = `held back — ${group.file} switches to ${run.env} only when every per-environment value can land`
      } else {
        text = setKey(text, name, value)
        landed[name] = value
        row = 'written'
      }
    } else if (outcome === 'unchanged' && value !== null) {
      landed[name] = value
      row = 'unchanged'
    } else if (outcome === 'conflict') {
      row = conflictRow(name, spec, run, fileEnv)
      attention = true
    } else {
      row = missingRow(name, spec, run)
      attention = true
    }
    lines.push(`  ${name.padEnd(width)}  ${row}`)
  }

  if (text !== original) writeSecretFile(group.path, text)
  recordValues(
    run.state,
    group.path,
    run.project,
    blocked ? fileEnv : run.env,
    landed,
  )
  return { lines, attention }
}

function ownerCommand(args: ParsedArgs, groups: FileGroup[]): string {
  const env = args.flags.env === undefined ? '' : ` --env ${args.flags.env}`
  const force = args.flags.force ? ' --force' : ''
  return `bwenv sync${env}${fileFlag(args.flags.file, groups)}${force}`
}

export async function runSync(ctx: Context, args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) {
    throw new BwenvError(
      'bwenv sync takes no names. Use --file to narrow it.',
      2,
    )
  }
  const loaded = loadManifest(ctx.cwd)
  const env = args.flags.env ?? defaultEnvironment(loaded.manifest)
  if (!ENV_PATTERN.test(env)) {
    throw new BwenvError(
      `--env ${env} is not an environment name. Use lower case letters, digits and -.`,
      2,
    )
  }
  const groups = groupByFile(loaded, ctx.home, args.flags.file)
  const vault = await openVault({
    env: ctx.env,
    isTTY: ctx.isTTY,
    ownerCommand: ownerCommand(args, groups),
    stderr: ctx.stderr,
  })
  const project = loaded.manifest.project
  const folderId = await vault.folderId(project, false)
  const run: SyncRun = {
    project,
    env,
    defaultEnv: defaultEnvironment(loaded.manifest),
    envFlag: args.flags.env === undefined ? '' : ` --env ${env}`,
    force: args.flags.force,
    vault,
    items: folderId === null ? [] : await vault.items(folderId),
    state: loadState(ctx.statePath),
  }

  const results = groups.map((group) => syncGroup(group, run))
  saveState(ctx.statePath, run.state)
  ctx.stdout.write(
    `${results.map((result) => result.lines.join('\n')).join('\n\n')}\n`,
  )
  return results.some((result) => result.attention) ? 1 : 0
}
