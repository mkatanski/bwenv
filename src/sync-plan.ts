import { hashValue } from './state'

export type SyncOutcome = 'unchanged' | 'write' | 'conflict' | 'missing'

export function decideSync(input: {
  local: string | null
  vault: string | null
  lastWrittenHash: string | null
  force: boolean
}): SyncOutcome {
  const { local, vault, lastWrittenHash, force } = input
  if (vault === null) return 'missing'
  if (local === vault) return 'unchanged'
  if (local === null || force) return 'write'
  if (lastWrittenHash === hashValue(local)) return 'write'
  return 'conflict'
}
