# Working on t3-port

Imports Claude Code and Codex sessions into T3 Code. It writes to T3's live database, so most
rules here exist because getting it wrong corrupts someone's history.

## What this writes into

T3 Code is event sourced. `orchestration_events` is the log; every `projection_*` table is
derived from it when the server boots.

**Append events. Never write a projection row.** A projection is rebuilt from the log, so a row
written directly is undone on the next rebuild — the one exception is
`provider_session_runtime`, which is not a projection and is the only table this tool writes to
by hand.

**Never invent an event shape.** Every command builder in `src/t3/commands.ts` mirrors one
branch of T3's `apps/server/src/orchestration/decider.ts`, and the comments cite the line. T3
validates every event when it starts, so an event it cannot decode stops it booting. If you need
a new event, read the decider branch first and reproduce it exactly, including which fields are
omitted.

**T3 must be quit before writing.** Its live projection path sets the shared cursor to the
sequence of the event it just handled, without looking for rows in between, so events written
underneath a running T3 are stepped over and never projected — and no restart recovers them.

## Rules that came from breaking something

- **A filter must filter.** `--project` once forced its target onto every session, so
  `import --all --project X` swept an entire disk into X. Flags that name a thing narrow the
  set; redirecting is a separate, explicit flag.
- **A session owns its stream for good.** Thread ids are derived from session ids, so
  re-importing after an undo appended a second `thread.created` to a live stream. `EventLog`
  now refuses to recreate an aggregate that has events.
- **Read state from the log, not the projections.** Projections only advance when T3 starts, so
  anything written since its last run is invisible there.
- **Don't guess which project a session belongs to.** Git resolves a live worktree; a deleted
  one only ever produces a suggestion the user confirms.
- **Prefer the real thing over a plausible one.** Both known data-loss bugs were found by
  running against a copy of real data, not by reasoning about it.

## Adding a provider

One module in `src/providers/` implementing `Provider`, plus a line in the registry. Its
`--flag` and help text are generated. Nothing outside `src/providers/` may branch on a provider
id — that coupling is what the interface exists to prevent, and `grep -rn '"codex"' src/`
outside that directory should stay empty.

The resume cursor is the field to get right: Claude stores `{threadId, resume}`, Codex stores
`{threadId: <session>}`. Writing the wrong shape leaves a thread that looks imported and cannot
continue, and nothing catches it until someone tries.

## Before you commit

```sh
bunx tsc --noEmit && bun test && ./e2e.sh
```

`e2e.sh` runs every command against a throwaway copy of the live database and asserts on the
resulting event log. It has caught more real defects than the unit tests have. When it fails,
check whether the fixture drifted before changing an assertion — twice the "wrong" number was
the code telling the truth.

Never point a write command at `~/.t3` to try something out. Set `T3CODE_HOME` to a copy.
