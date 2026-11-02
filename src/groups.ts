import { BwenvError } from './errors'
import { resolveFile, type LoadedManifest, type VariableSpec } from './manifest'

export interface FileGroup {
  file: string
  path: string
  variables: [string, VariableSpec][]
}

export function groupByFile(
  loaded: LoadedManifest,
  home: string,
  only?: string,
): FileGroup[] {
  const groups = new Map<string, FileGroup>()
  for (const [name, spec] of Object.entries(loaded.manifest.variables)) {
    const path = resolveFile(loaded, spec.file, home)
    const group = groups.get(path) ?? { file: spec.file, path, variables: [] }
    group.variables.push([name, spec])
    groups.set(path, group)
  }
  const all = [...groups.values()]
  if (only === undefined) return all

  const wanted = resolveFile(loaded, only, home)
  const selected = all.filter((group) => group.path === wanted)
  if (selected.length === 0) {
    throw new BwenvError(
      `${only} is not a file any variable in ${loaded.path} uses.`,
      2,
    )
  }
  return selected
}
