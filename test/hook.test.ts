import { beforeAll, expect, test } from 'bun:test'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'

import { FAKE_BW, makeSandbox, runCli } from './helpers'

beforeAll(() => {
  chmodSync(FAKE_BW, 0o755)
})

const MANIFEST = { project: 'p', variables: { A: { file: '.dev.vars' } } }

test('hook claude blocks a Read of a secret file with exit 2', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    cwd: sandbox.project,
    tool_name: 'Read',
    tool_input: { file_path: join(sandbox.project, '.dev.vars') },
  })
  const result = await runCli(sandbox, ['hook', 'claude'], { stdin: payload })
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('bwenv list')
})

test('hook claude lets an ordinary call through', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const payload = JSON.stringify({
    cwd: sandbox.project,
    tool_name: 'Bash',
    tool_input: { command: 'git status' },
  })
  const result = await runCli(sandbox, ['hook', 'claude'], { stdin: payload })
  expect(result.code).toBe(0)
})

test('hook claude fails open on unreadable input', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const result = await runCli(sandbox, ['hook', 'claude'], {
    stdin: 'not json',
  })
  expect(result.code).toBe(0)
  expect(result.stderr).toContain('bwenv hook: unreadable input')
})

test('hook claude runs for an agent', async () => {
  const sandbox = makeSandbox(MANIFEST)
  const payload = JSON.stringify({
    cwd: sandbox.project,
    tool_name: 'Bash',
    tool_input: { command: 'cat .dev.vars' },
  })
  const result = await runCli(sandbox, ['hook', 'claude'], {
    stdin: payload,
    env: { CLAUDECODE: '1' },
  })
  expect(result.code).toBe(2)
})

test('hook needs the claude argument', async () => {
  const sandbox = makeSandbox(MANIFEST)
  expect((await runCli(sandbox, ['hook'])).code).toBe(2)
})

test('is-secret answers with its exit code', async () => {
  const sandbox = makeSandbox(MANIFEST)
  expect((await runCli(sandbox, ['is-secret', '.dev.vars'])).code).toBe(0)
  expect((await runCli(sandbox, ['is-secret', 'README.md'])).code).toBe(1)
})
