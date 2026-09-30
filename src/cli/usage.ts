import { PROVIDERS } from "../providers/index.ts";

export const USAGE = `t3p — move conversation history into T3 Code

  t3p doctor                        check this tool against the installed T3 Code
  t3p list --path <dir>             sessions from a checkout, with their status in T3
  t3p import --path <dir>           import a checkout's sessions as T3 threads
  t3p import <ref...>               import named sessions; no --path needed
  t3p prune --path <dir>            find transcript copies nothing can reach
  t3p runs                          import runs, newest first
  t3p undo [run]                    undo the newest import, or a named run

Scope
  --path <dir>           a checkout — with its subdirectories and every worktree made from it —
                         or a single worktree, which covers only itself. Required for list, and
                         for import unless sessions are named: answering a question about one
                         repository should not mean reading every transcript on the machine.
                         A named session needs no scope, and one it did not run in will not
                         reject it.

Providers (all unless named)
${PROVIDERS.map((p) => `  --${p.label.padEnd(18)} ${p.id}`).join("\n")}

List
  Terms filter by substring across agent, session id, project, directory and title. Every term
  must match, so they narrow: "list codex web-app" is Codex sessions under web-app.

  --sort <field>         recent (default), project, turns, agent or title
  --limit <n>            rows to show; 0 for all. Defaults to 40 in a terminal, all when piped
  --offset <n>           skip this many rows

Import
  --dry-run              plan only, write nothing
  --path <dir>           only sessions that ran in this checkout or a worktree of it
  --project <path|id>    only sessions that ran under this project
  --force-project        with --project, redirect every session there regardless of where it ran
  --create-project       create a project when none covers the session
  --include-live         import sessions that still look like they are running
  --settled              leave imported threads settled, out of the active list
  --reclaim              import even though a T3 thread already resumes the session, as when
                         that thread was deleted or archived and the conversation is wanted back
  --drop-generated       drop preamble a provider wrote as user turns (Codex AGENTS.md,
                         <environment_context>); off by default so no real user text is removed

Prune
  --delete               actually remove them; without it, prune only reports

Undo
  --dry-run              show what would change, change nothing

An import T3 has not read yet is lifted out whole, leaving its sessions importable again. Once
T3 has read it, its threads are deleted the way T3 deletes a thread and the sessions stay
claimed — a thread id comes from its session, so re-importing would give one stream two
creation events.

Everywhere
  --force                write even if T3's schema drifted from the baseline
  -h, --help             this text

T3 Code must be quit before writing: it only folds new events in at startup.
`;
