import type { Context } from './context'
import { checkValue, parseEnv } from './dotenv'
import { BwenvError } from './errors'
import { readText } from './files'
import { readValue } from './prompt'

export async function obtainValue(
  ctx: Context,
  name: string,
  fromFile: boolean,
  filePath: string,
): Promise<string> {
  let value: string
  if (fromFile) {
    const fromDisk = parseEnv(readText(filePath) ?? '').get(name)
    if (fromDisk === undefined) {
      throw new BwenvError(
        `${name} is not in ${filePath}, so --from-file has nothing to send.`,
      )
    }
    value = fromDisk
  } else {
    value = await readValue(`Value for ${name}`, ctx)
  }
  checkValue(name, value)
  return value
}
