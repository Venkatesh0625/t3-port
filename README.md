# t3-port

Import Claude Code and Codex sessions into [T3 Code](https://github.com/pingdotgg/t3code) as
threads that resume the original provider session. Bun + TypeScript, no dependencies.

## Install

Bun is required — this uses `bun:sqlite`, `Bun.spawnSync`, `Bun.CryptoHasher` and `Bun.file`,
so it will not run under Node.

```sh
bun install
bun link                       # puts `t3-port` on your PATH
bun run build                  # or a standalone binary at dist/t3-port
```

## Use

```sh
t3-port doctor                 # is this tool safe against your installed T3?
t3-port list                   # sessions on disk, marked t3 / imported / -
t3-port import --dry-run       # plan; no references means every importable session
t3-port import                 # write (quit T3 Code first)
t3-port runs                   # import runs, newest first
t3-port undo                   # take the newest import back
```

Narrow any of it:

```sh
t3-port list --path ~/code/web-app      # a checkout and the worktrees made from it
t3-port prune --path ~/code/web-app     # transcript copies nothing can reach
t3-port list web-app deploy             # filter by word: agent, id, project, directory, title
t3-port list --sort project             # group by project
t3-port import --codex --drop-generated # one provider
t3-port import 347cd91a                 # one session, by id prefix
```

The project column reads `manager/repo/leaf` — `superset/app/few-column`, `t3/app/t3code-e204`,
`/app/(parent)` for the checkout itself, `NA` when a session recorded no directory. Which tool
made a worktree and what it came from are the facts that tell two rows apart, so they sit at the
front and a long worktree name is shortened instead.

Command records and one-line sessions (`/clear`, `/login`, workspace-naming prompts) are hidden
from listings and skipped by imports; `--include-noise` keeps them.

`--path` names a **checkout**, not a directory tree. `--path ~/code/app` covers that repository,
its subdirectories and the worktrees made from it, wherever those are kept. It does not cover a
different checkout that merely sits underneath — which is what keeps `--path ~` from meaning
"everything on the machine".

| Variable | Default |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | `~/.claude` |
| `CODEX_HOME` | `~/.codex` |
| `T3CODE_HOME` | `~/.t3` |

Point `T3CODE_HOME` at a copy of `~/.t3` to rehearse against a throwaway database.

## How it works

T3 Code is event sourced. `orchestration_events` is the log; every `projection_*` table is
derived from it when the server boots. So an import appends events and lets T3 project them —
writing a projection row directly would be undone on the next rebuild.

An import writes three things:

1. **A `thread.create` command** → one `thread.created` event.
2. **A `thread.history.import` command** → one `thread.message-sent` per turn, then one
   `thread.settled` dated to the newest turn. This is what makes the conversation *visible*;
   without it the thread renders empty.
3. **A `provider_session_runtime` row** whose resume cursor points at the original session, so
   the next message continues it with full model context.

Every event is tagged `metadata_json = {"historyImport": true}`, and the cursor is written
before the thread's events so a thread is never visible without the binding that lets it
continue.

Thread ids are deterministic — `import:<provider>:<sessionId>`, with message ids
`<threadId>:<index padded to 6>`. That makes "already imported?" a prefix scan over the event
log, and it matches T3's own convention, so T3 recognises these threads as imports.

Command shapes come from T3's source rather than guesswork:

| What | Where |
| --- | --- |
| Thread and message id format, resume cursor | `AgentSessionImporter.ts:147,168,234,267` |
| `thread.history.import` → message-sent + settled | `decider.ts:2003-2073` |
| `attachments` / `context` optional on messages | `contracts/orchestration.ts:1912` |

**T3 Code must be quit before writing.** Its live projection path advances a shared cursor to
the sequence of the event it just handled, without checking for rows in between — so events
written underneath a running T3 are stepped over and never projected, and no restart recovers
them. The tool refuses to write while the server is up, detected with `ps` rather than `/proc`,
which does not exist on macOS.

**Compatibility is structural.** T3's migration id rises for changes that have nothing to do
with this tool, so `doctor` hashes the DDL of the six tables actually written and compares
against a baseline. A migration that leaves them alone is reported safe; a changed table stops
writes until the event shapes are re-verified. `--force` overrides, and a backup is taken before
every write.

## Testing

```sh
bun test      # unit tests
./e2e.sh      # end-to-end against a throwaway copy of the live state
```

`e2e.sh` builds a sandbox from the most recent backup plus copies of both provider homes, runs
every command for both providers, and asserts on the resulting event log. It writes nothing
outside `/tmp/t3-port-e2e`.

## Licence

MIT
