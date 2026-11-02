export class BwenvError extends Error {
  readonly exitCode: 1 | 2

  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message)
    this.name = 'BwenvError'
    this.exitCode = exitCode
  }
}
