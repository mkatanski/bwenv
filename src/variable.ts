import type { ParsedArgs } from './args'
import { checkName, ENV_PATTERN, setKey } from './dotenv'
import { BwenvError } from './errors'
import { assertIgnoredIfInRepo, readText, writeSecretFile } from './files'
import {
  defaultEnvironment,
  itemName,
  loadManifest,
  resolveFile,
  type LoadedManifest,
  type VariableSpec,
} from './manifest'
import {
  fileHoldsEnvironment,
  loadState,
  recordValues,
  saveState,
} from './state'

export interface Target {
  loaded: LoadedManifest
  name: string
  spec: VariableSpec
  env: string | null
  path: string
  item: string
}

export function singleName(args: ParsedArgs): string {
  const [name, ...extra] = args.positionals
  if (name === undefined || extra.length > 0) {
    throw new BwenvError(`bwenv ${args.command} takes exactly one NAME.`, 2)
  }
  checkName(name)
  return name
}

export function checkEnvFlag(
  name: string,
  spec: VariableSpec,
  env: string | undefined,
): void {
  if (env === undefined) return
  if (!ENV_PATTERN.test(env)) {
    throw new BwenvError(
      `--env ${env} is not an environment name. Use lower case letters, digits and -.`,
      2,
    )
  }
  if (spec.perEnvironment !== true) {
    throw new BwenvError(
      `${name} is the same in every environment; drop --env.`,
      2,
    )
  }
}

export function targetOf(
  loaded: LoadedManifest,
  name: string,
  spec: VariableSpec,
  envFlag: string | undefined,
  home: string,
): Target {
  checkEnvFlag(name, spec, envFlag)
  const env =
    spec.perEnvironment === true
      ? (envFlag ?? defaultEnvironment(loaded.manifest))
      : null
  const path = resolveFile(loaded, spec.file, home)
  assertIgnoredIfInRepo(path)
  return {
    loaded,
    name,
    spec,
    env,
    path,
    item: itemName(loaded.manifest.project, name, env),
  }
}

export function declaredTarget(
  cwd: string,
  home: string,
  args: ParsedArgs,
): Target {
  const name = singleName(args)
  const loaded = loadManifest(cwd)
  const spec = loaded.manifest.variables[name]
  if (spec === undefined) {
    throw new BwenvError(
      `${name} is not declared in bwenv.json. To add a new variable: bwenv add ${name} --file <path>`,
      2,
    )
  }
  return targetOf(loaded, name, spec, args.flags.env, home)
}

export function writeLocal(
  target: Target,
  value: string,
  statePath: string,
): string | null {
  const { loaded, name, spec, env, path } = target
  const state = loadState(statePath)
  const defaultEnv = defaultEnvironment(loaded.manifest)
  if (env !== null && !fileHoldsEnvironment(state, path, env, defaultEnv)) {
    const current = state[path]?.environment ?? defaultEnv
    return `Saved to Bitwarden only: ${spec.file} holds ${current} values. Switch with: bwenv sync --env ${env}`
  }
  writeSecretFile(path, setKey(readText(path) ?? '', name, value))
  recordValues(
    state,
    path,
    loaded.manifest.project,
    state[path]?.environment ?? env ?? defaultEnv,
    { [name]: value },
  )
  saveState(statePath, state)
  return null
}

export function assertFromFileMatches(
  target: Target,
  fromFile: boolean,
  statePath: string,
): void {
  const { loaded, env, path, spec } = target
  if (!fromFile || env === null) return
  const state = loadState(statePath)
  const defaultEnv = defaultEnvironment(loaded.manifest)
  if (fileHoldsEnvironment(state, path, env, defaultEnv)) return
  const current = state[path]?.environment ?? defaultEnv
  throw new BwenvError(
    `${spec.file} holds ${current} values, so --from-file cannot send it as ${env}. Switch first: bwenv sync --env ${env}`,
  )
}

export function envSuffix(target: Target): string {
  return target.env === null ? '' : ` --env ${target.env}`
}
