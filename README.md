# t3-port

Import Claude Code and Codex sessions into [T3 Code](https://github.com/pingdotgg/t3code) as
threads that resume the original provider session. Bun + TypeScript, no dependencies.

## Install

Not published to npm, and it could not run under Node as written — it uses `bun:sqlite`,
`Bun.spawnSync`, `Bun.CryptoHasher` and `Bun.file`. Bun is required.

```sh
cd t3-port && bun install
bun link                       # puts `t3-port` on your PATH
```

Or build a standalone binary with the runtime embedded, for a machine without Bun:

```sh
bun run build                  # -> dist/t3-port (~55 MB)
```

Or skip installing and run it in place:

```sh
bun run src/main.ts doctor
```

## Use

```sh
t3-port doctor                 # is this tool safe against your installed T3?
t3-port list                   # Claude sessions, marked t3 / imported / -
t3-port import --all --dry-run # plan, write nothing
t3-port import --all           # write (quit T3 Code first)

t3-port import --codex --all   # one provider only (--claude likewise)
t3-port import 347cd91a                          # one session, by id prefix
t3-port import --all --project ~/personal/app    # force the target project
t3-port import --all --create-project            # create projects as needed
```

`doctor` exits 1 when T3's schema has drifted, so it works in a script:

```sh
t3-port doctor && t3-port import --all
```

### Environment

| Variable | Default |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | `~/.claude` |
| `CODEX_HOME` | `~/.codex` |
| `T3CODE_HOME` | `~/.t3` |

Point `T3CODE_HOME` at a copy of `~/.t3` to rehearse an import against a throwaway database.

## Layout

```
src/
  main.ts            entry point; dispatch only
  cli/               argument parsing (node:util parseArgs), usage, session collection, output
  commands/          one module per command
  providers/         one module per agent, behind a common interface
  ops/               planning and applying, provider-agnostic
  t3/                event log, command builders, queries, schema guard
```

Everything that differs between agents lives in `providers/`: where transcripts are, how to
read one, which session ids are resumable, the resume cursor shape, and whether the agent finds
a transcript by directory. The planner, the queries and the CLI only see the interface, so a
third agent is one new module plus a registry entry — its `--flag` and help text are generated.

## How it works

T3 Code is event sourced. `orchestration_events` is the log; every `projection_*` table is
derived from it when the server boots. So an import appends events and lets T3 project them —
writing a projection row directly would be undone on the next rebuild.

An import writes three things:

1. **A `thread.create` command** → one `thread.created` event.
2. **A `thread.history.import` command** → one `thread.message-sent` per turn, then one
   `thread.settled` dated to the newest turn. This is what makes the conversation *visible*;
   without it the thread renders empty.
3. **A `provider_session_runtime` row** whose `resume_cursor_json` is
   `{threadId, resume: <claude session uuid>}`. The Claude adapter passes `resume` to the Agent
   SDK, so the next message continues the real session with full model context.

Every event is tagged `metadata_json = {"historyImport": true}`, and the cursor is written before
the thread's events so a thread is never visible without the binding that lets it continue.

Thread ids are deterministic — `import:claudeAgent:<sessionId>`, with message ids
`<threadId>:<index padded to 6>`. That makes "already imported?" a prefix scan over the event
log, with no bookkeeping table, and it matches T3's own convention so T3 recognises these threads
as imports and never duplicates them.

### Derived from

Command shapes come from T3's own source, not from guessing:

| What | Where |
| --- | --- |
| Thread and message id format, resume cursor | `apps/server/src/project/AgentSessionImporter.ts:147,168,234,267` |
| `thread.history.import` → message-sent + settled | `apps/server/src/orchestration/decider.ts:2003-2073` |
| `attachments` / `context` optional on messages | `packages/contracts/src/orchestration.ts:1912` |
| Session ids T3 can resume | `apps/server/src/project/AgentSessionImporter.ts:32` |

## Codex

Codex differs from Claude in every way that matters, so the reader is separate:

| | Claude Code | Codex |
| --- | --- | --- |
| Location | `~/.claude/projects/<slugged cwd>/` | `~/.codex/sessions/<y>/<m>/<d>/` |
| Session id | the filename | only inside `session_meta` |
| Working directory | the directory name | only inside `session_meta` |
| Turns | `user` / `assistant` records | `response_item` with `input_text` / `output_text` |
| Resume cursor | `{threadId, resume: <session>}` | `{threadId: <session>}` |

That last row is the one that silently breaks things: writing Claude's cursor shape for a Codex
thread leaves the session unresumable.

### Generated preamble

Codex injects its own text as user turns — the AGENTS.md header, `<environment_context>`,
`<turn_aborted>`. T3 removes these only when an `event_msg` copy of the real prompt proves which
text in a turn the user actually submitted, and keeps everything otherwise rather than risk
deleting real user text. This reproduces that rule exactly.

In practice that rule rarely fires: across 78 local rollouts only 1 contained any `event_msg`
user message, so 43 of 73 sessions would be titled `# AGENTS.md instructions for ...`. Pass
`--drop-generated` to filter the known preambles instead. It stays opt-in, and the plan reports
how many turns it would affect.

## What it does not import

Text turns only. Tool calls, reasoning blocks, and attachments are dropped — in a representative
transcript, 91 of 97 `user` records were `tool_result`. The resumed session still has the full
context, so the model remembers more than the thread displays.

## Safety

**T3 Code must be closed.** It only reads new events at startup, and a malformed event would stop
it booting. The tool refuses to write while the server is live, detected with `ps` rather than
`/proc` — `/proc` does not exist on macOS, so a `/proc`-based check reports "nothing running" on
every Mac and fails open exactly when it matters.

**Compatibility is structural, not a version number.** T3's migration id rises for changes that
have nothing to do with this tool: 53 (`PullRequestFilesViewed`) and 54
(`ProjectionThreadsAutoSettleDisabledAt`) both bumped it without touching anything written here.
Instead, `doctor` hashes the DDL of the six tables in the write surface and compares against a
baseline. A migration bump that leaves those unchanged is reported as safe; a changed table is a
hard stop until the event shapes are re-verified. `--force` overrides.

**A backup is taken before every write**, via `VACUUM INTO` so it reflects committed state
including the WAL. Restore it if T3 refuses to boot.

## Verified against

T3 Code `0.0.43-nightly.20260928.2375`, schema migration 54, macOS.

29 sessions imported into a copy of a real 294 MB `state.sqlite`, then checked:
`thread.created` and `thread.settled` payload keys identical to T3's own events; `stream_version`
contiguous from 0 on every stream; no orphan events or dangling receipts; one resume cursor per
thread; re-running reports 0 to import.

## Scope

Implemented: `doctor`, `list`, `import`. Export (T3 threads → `claude --resume`) and sync are not
built yet.

## Testing

```sh
bun test      # unit tests for the id conventions, command shapes and provider rules
./e2e.sh      # end-to-end against a throwaway copy of the live state
```

`e2e.sh` builds a sandbox from the most recent pre-import backup plus copies of both provider
homes, then exercises every command for both providers and asserts on the resulting event log:
cursor shapes per provider, no `stream_version` gaps, a receipt per event, one settled event per
thread, no stream created twice, idempotent re-import, undo finality, and each guard. It writes
nothing outside `/tmp/t3-port-e2e`.

## Undo is final for a session

A thread id is derived from the session id, so a session owns one event stream forever.
Re-importing after an undo would append a second creation to that stream, leaving an aggregate
T3 cannot fold into one thread. `undo` therefore frees the conversation, not the id: the session
stays marked as imported. To genuinely start over, restore a backup from before the import.
