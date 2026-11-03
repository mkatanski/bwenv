# bwenv

Local secret files (`.env`, `.dev.vars`, `~/.something-keys`), rebuilt on demand from a private
Bitwarden vault.

Each project commits a `bwenv.json` saying which variables it needs, which file each one goes in and
how to make one. The vault holds the values. The files on disk are a copy: lose them, and
`bwenv sync` writes them back.

Design and reasoning: `docs/designs/2026-11-02-bwenv.md`.

## Install

Requires [Bun](https://bun.sh) and the Bitwarden CLI (`bw`), logged in (`bw login`).

```bash
git clone git@github.com:mkatanski/bwenv.git ~/projects/mkatanski/bwenv
cd ~/projects/mkatanski/bwenv && bun install && bun link
bwenv help
```

`bun link` puts `bwenv` in `~/.bun/bin`, pointing at this checkout, so an edit here takes effect at
once.

## `bwenv.json`

```json
{
  "project": "my-app",
  "defaultEnvironment": "local",
  "variables": {
    "API_KEY": {
      "file": "~/.my-app-keys",
      "how": "the provider's dashboard → Settings → API Keys → Create Key"
    },
    "AUDIENCE_ID": {
      "file": ".dev.vars",
      "perEnvironment": true,
      "how": "the provider's dashboard → Audiences"
    }
  }
}
```

- `file`: `~/…` for a file in the home directory, shared by every checkout, or a path relative to
  `bwenv.json`, which belongs to that checkout. Absolute paths, and paths that leave the project or
  the home directory, are refused.
- `perEnvironment`: the value differs between environments. `--env` picks the environment, and the
  default is `defaultEnvironment` (`local` if unset).
- `how`: shown whenever the value is missing.

**A project file must be ignored by the repository's own `.gitignore`.** An ignore in
`~/.gitignore_global` does not count, because another clone would not have it. bwenv refuses to
write a file git would commit.

## Commands

No command ever prints a value. A value is typed into a hidden prompt or piped on stdin
(`pbpaste | bwenv add X`), never passed as an argument, so it never lands in shell history.

| Command | What it does |
|---|---|
| `bwenv sync [--env e] [--file f] [--force]` | Writes the vault's values into the files. A value changed by hand is a **conflict** and is left alone: keep yours with `bwenv update NAME --from-file`, or take the vault's with `--force`. A value missing from the vault is reported, never deleted locally. |
| `bwenv add NAME [--file f] [--env e] [--from-file] [--how text]` | Creates the vault item and writes the file. A new name needs `--file` and is added to `bwenv.json`. `--from-file` sends the value already in the file. |
| `bwenv update NAME [--env e] [--from-file]` | Replaces the value. The old one stays in the item's password history. |
| `bwenv rm NAME [--env e] [--yes]` | Deletes the item, or with `--env` that environment's item only, to the Bitwarden trash (30 days). Without `--env` it also removes the line and the `bwenv.json` entry. |
| `bwenv list [--file f] [--vault]` | Declared variables per file, `set` or `missing`. Works with the vault locked. `--vault` adds `same`, `differs` or `not in vault`. |
| `bwenv is-secret PATH` | Exit 0 if the path holds secrets, 1 if not. |
| `bwenv hook claude` | Claude Code `PreToolUse` hook, see below. |

Exit codes: `0` done, `1` something needs your attention, `2` wrong usage.

## The vault

- Folder `bwenv/<project>`.
- One Login item per variable: `<project>/<NAME>`, or `<project>/<env>/<NAME>` for a
  `perEnvironment` variable. The username is the variable name and the password is the value.
- bwenv runs `bw sync` before reading.
- When `BW_SESSION` is not set, bwenv asks for the master password itself and keeps the session only
  for that run. To be asked once per shell instead, run `export BW_SESSION=$(bw unlock --raw)`.

State (`~/.local/state/bwenv/state.json`) records a hash of each value bwenv wrote, never the value,
plus the environment each file holds.

## Agents never touch the vault

When `CLAUDECODE=1` is set, `sync`, `add`, `update`, `rm` and `list --vault` refuse before calling
`bw` and print the command for the owner to run. `list`, `is-secret` and `hook` still work.

Hook it into Claude Code, in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Edit|Write|NotebookEdit|Grep|Bash",
        "hooks": [{ "type": "command", "command": "bwenv hook claude" }]
      }
    ]
  }
}
```

The hook blocks reading or editing a secret file, along with any shell command that reads one
(`cat`, `grep`, `cp`, redirections and the like) or calls `bw`. It lets through `.`/`source`,
`bun --env-file`, `ls`, `test -f`, `git check-ignore` and `bwenv` itself.

A path counts as secret if it is:
- named `.env*` (except `.env.example`) or `.dev.vars*`;
- declared in a `bwenv.json`;
- or any file bwenv has ever written on this machine.

The hook is a guardrail against accidents, not a lock.

## Development

```bash
bun run check   # typecheck, lint, format check, tests
```

Tests run the real CLI against a fake `bw` (`test/fake-bw.ts`, selected with `BWENV_BW`). Three
things only the real vault can prove: the `bw` response shapes, the unlock prompt, and password
history on `update`. Check them by hand after changing `src/bitwarden.ts`:

```bash
mkdir -p /tmp/bwenv-smoke && cd /tmp/bwenv-smoke && git init -q && printf '.env\n' > .gitignore
printf '{\n  "project": "bwenv-smoke",\n  "variables": {}\n}\n' > bwenv.json
bwenv add SMOKE_TOKEN --file .env       # unlock prompt if no BW_SESSION, then the value: first-value
bwenv list --vault                      # SMOKE_TOKEN  set · same
bwenv update SMOKE_TOKEN                # second-value
bw get item bwenv-smoke/SMOKE_TOKEN | jq '[.passwordHistory[]?.password]'   # contains first-value once
printf 'SMOKE_TOKEN=handedit\n' > .env && bwenv sync    # conflict, exit 1
bwenv sync --force && bwenv list --vault                # same
bwenv rm SMOKE_TOKEN                    # confirm; the item goes to the trash
bw delete folder "$(bw list folders --search bwenv/bwenv-smoke | jq -r '.[0].id')"; cd / && rm -rf /tmp/bwenv-smoke
```
