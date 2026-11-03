const SAFE = /^[A-Za-z0-9._/~@%+=:,-]+$/

export function shellQuote(value: string): string {
  if (SAFE.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function fileFlag(
  requested: string | undefined,
  groups: readonly { file: string }[],
): string {
  const [only] = groups
  if (requested === undefined || only === undefined) return ''
  return ` --file ${shellQuote(only.file)}`
}
