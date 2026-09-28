import { PROVIDERS } from "../providers/index.ts";

export const USAGE = `t3-port — move conversation history into T3 Code

  t3-port doctor                    check this tool against the installed T3 Code
  t3-port list                      sessions on disk, with their status in T3
  t3-port import [ref...]           import sessions as T3 threads (all importable if none named)
  t3-port runs                      import runs, newest first
  t3-port undo [run]                undo the newest import, or a named run

Providers (all unless named)
${PROVIDERS.map((p) => `  --${p.label.padEnd(18)} ${p.id}`).join("\n")}

Import
  --dry-run              plan only, write nothing
  --project <path|id>    only sessions that ran under this project
  --force-project        with --project, redirect every session there regardless of where it ran
  --create-project       create a project when none covers the session
  --drop-generated       drop preamble a provider wrote as user turns (Codex AGENTS.md,
                         <environment_context>); off by default so no real user text is removed

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
