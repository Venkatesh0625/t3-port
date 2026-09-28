# t3-port

Import Claude Code sessions into [T3 Code](https://github.com/pingdotgg/t3code) as threads that
resume the same Claude session. Bun + TypeScript, no dependencies.

```sh
bun run src/cli.ts doctor                 # is this tool safe against your installed T3?
bun run src/cli.ts list                   # Claude sessions, marked t3 / imported / -
bun run src/cli.ts import --all --dry-run # plan
bun run src/cli.ts import --all           # write (T3 Code must be closed)
```

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
