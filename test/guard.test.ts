import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isSecretPath,
  judgeBash,
  judgeToolCall,
  type GuardContext,
} from '../src/guard'
import { recordValues, saveState, statePath, type State } from '../src/state'
import { makeSandbox } from './helpers'

function guardContext(): GuardContext {
  const sandbox = makeSandbox({
    project: 'p',
    variables: { K: { file: '~/.k' }, A: { file: '.dev.vars' } },
  })
  const path = statePath({ XDG_STATE_HOME: sandbox.stateHome }, sandbox.home)
  const state: State = {}
  recordValues(state, join(sandbox.home, '.other'), 'q', 'local', { O: 'x' })
  saveState(path, state)
  return { cwd: sandbox.project, home: sandbox.home, statePath: path }
}

const ctx = guardContext()

describe('judgeBash denies', () => {
  for (const command of [
    'cat .dev.vars',
    'grep X ~/.k',
    'cp .env /tmp/x',
    'echo hi > .dev.vars',
    'echo hi >> .dev.vars',
    'sort <.env',
    'cat "$HOME/.k"',
    "cat '.dev.vars'",
    'head ${HOME}/.other',
    'FOO=1 cat .dev.vars',
    'ls && cat .dev.vars',
    'ls | cat .dev.vars',
    'ls; cat .dev.vars',
    'cat .env.local',
    'cat config/.dev.vars.staging',
    'sudo cat .dev.vars',
    'jq --arg x 1 . .dev.vars',
    'bw list items',
    '/opt/homebrew/bin/bw get password x',
  ]) {
    test(command, () => {
      expect(judgeBash(command, ctx)).not.toBeNull()
    })
  }
})

describe('judgeBash allows', () => {
  for (const command of [
    'set -a && . ~/.k && set +a',
    'source .dev.vars',
    'bun --env-file=$HOME/.k x.ts',
    'git check-ignore .dev.vars',
    'ls -la .dev.vars',
    'test -f .env',
    'chmod 600 .env',
    'bwenv list --file .dev.vars',
    'bwenv sync',
    'npm run env:list',
    'cat README.md',
    'cat .env.example',
    'echo "cat .dev.vars"',
  ]) {
    test(command, () => {
      expect(judgeBash(command, ctx)).toBeNull()
    })
  }
})

test('the denial names the path and points to bwenv list', () => {
  expect(judgeBash('cat .dev.vars', ctx)).toBe(
    '.dev.vars holds secrets. Use: bwenv list (names only, no values)',
  )
  expect(judgeBash('bw get item x', ctx)).toBe(
    'Agents do not use the Bitwarden CLI. Ask the owner, or use: bwenv list',
  )
})

describe('judgeToolCall', () => {
  test('Read of the project .dev.vars is denied', () => {
    const input = {
      tool_name: 'Read',
      tool_input: { file_path: join(ctx.cwd, '.dev.vars') },
    }
    expect(judgeToolCall(input, ctx)).not.toBeNull()
  })

  test('Read of a state-recorded home file is denied from a cwd with no manifest', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'bwenv-elsewhere-'))
    const input = {
      tool_name: 'Read',
      tool_input: { file_path: join(ctx.home, '.other') },
      cwd: elsewhere,
    }
    expect(judgeToolCall(input, ctx)).not.toBeNull()
  })

  test('Read of a manifest home file is denied from the project', () => {
    const input = {
      tool_name: 'Read',
      tool_input: { file_path: join(ctx.home, '.k') },
    }
    expect(judgeToolCall(input, ctx)).not.toBeNull()
  })

  test('Edit of a relative .env is denied', () => {
    const input = { tool_name: 'Edit', tool_input: { file_path: '.env' } }
    expect(judgeToolCall(input, ctx)).not.toBeNull()
  })

  test('Grep on .dev.vars is denied, Grep without a path is allowed', () => {
    expect(
      judgeToolCall(
        { tool_name: 'Grep', tool_input: { pattern: 'X', path: '.dev.vars' } },
        ctx,
      ),
    ).not.toBeNull()
    expect(
      judgeToolCall({ tool_name: 'Grep', tool_input: { pattern: 'X' } }, ctx),
    ).toBeNull()
  })

  test('Bash goes through judgeBash', () => {
    expect(
      judgeToolCall(
        { tool_name: 'Bash', tool_input: { command: 'cat .dev.vars' } },
        ctx,
      ),
    ).not.toBeNull()
  })

  test('ordinary files and unknown tools are allowed', () => {
    expect(
      judgeToolCall(
        {
          tool_name: 'Read',
          tool_input: { file_path: join(ctx.cwd, 'src', 'a.ts') },
        },
        ctx,
      ),
    ).toBeNull()
    expect(
      judgeToolCall({ tool_name: 'WebFetch', tool_input: { url: 'x' } }, ctx),
    ).toBeNull()
  })
})

test('a broken manifest does not break the guard', () => {
  const root = mkdtempSync(join(tmpdir(), 'bwenv-broken-'))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'bwenv.json'), '{ not json')
  const broken = { ...ctx, cwd: join(root, 'sub') }
  expect(isSecretPath('README.md', broken)).toBe(false)
  expect(isSecretPath('.env', broken)).toBe(true)
})

describe('judgeToolCall closes the obvious side doors', () => {
  test('a symlink to a secret file and an upper-case name are both denied', () => {
    writeFileSync(join(ctx.cwd, '.dev.vars'), 'A=1\n')
    symlinkSync(join(ctx.cwd, '.dev.vars'), join(ctx.cwd, 'notes.txt'))
    for (const file_path of [
      join(ctx.cwd, 'notes.txt'),
      join(ctx.cwd, '.ENV'),
    ]) {
      expect(
        judgeToolCall({ tool_name: 'Read', tool_input: { file_path } }, ctx),
      ).not.toBeNull()
    }
  })

  test('MultiEdit is covered like Edit', () => {
    expect(
      judgeToolCall(
        { tool_name: 'MultiEdit', tool_input: { file_path: '.env' } },
        ctx,
      ),
    ).not.toBeNull()
  })

  test('Grep with a glob aimed at secret files is denied', () => {
    for (const glob of ['.env*', '**/.dev.vars', '.env.local']) {
      expect(
        judgeToolCall(
          { tool_name: 'Grep', tool_input: { pattern: 'X', glob } },
          ctx,
        ),
      ).not.toBeNull()
    }
    expect(
      judgeToolCall(
        { tool_name: 'Grep', tool_input: { pattern: 'X', glob: '*.ts' } },
        ctx,
      ),
    ).toBeNull()
  })
})

describe('recursive searches', () => {
  for (const command of [
    'grep -rn API_KEY .',
    'grep -rn API_KEY',
    'grep -R X',
    'grep --recursive X .',
    'egrep KEY .env',
    'rgrep X .',
    'grep -e X .dev.vars',
    'rg --hidden --no-ignore X',
    'rg -uu X .',
  ]) {
    test(`denies ${command}`, () => {
      expect(judgeBash(command, ctx)).not.toBeNull()
    })
  }
  for (const command of [
    "grep -rn '.dev.vars' docs/",
    "grep -n '.dev.vars' README.md",
    'grep -e .env README.md',
    'grep -rn X src',
    'rg X .',
    'rg -r replacement X src',
  ]) {
    test(`allows ${command}`, () => {
      expect(judgeBash(command, ctx)).toBeNull()
    })
  }
  test('the denial suggests git grep', () => {
    expect(judgeBash('grep -rn API_KEY .', ctx)).toContain('git grep')
  })
})
