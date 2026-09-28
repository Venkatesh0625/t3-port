import { PROVIDERS } from "../providers/index.ts";

export const USAGE = `t3-port — move conversation history into T3 Code

  t3-port doctor                    check this tool against the installed T3 Code
  t3-port list                      sessions on disk, with their status in T3
  t3-port import [ref...]           import sessions as T3 threads
  t3-port undo                      delete threads this tool imported

Providers (all unless named)
${PROVIDERS.map((p) => `  --${p.label.padEnd(18)} ${p.id}`).join("\n")}

Import
  --all                  every importable session
  --dry-run              plan only, write nothing
  --project <path|id>    only sessions that ran under this project
  --force-project        with --project, redirect every session there regardless of where it ran
  --create-project       create a project when none covers the session
  --drop-generated       drop preamble a provider wrote as user turns (Codex AGENTS.md,
                         <environment_context>); off by default so no real user text is removed

Undo
  --all                  every imported thread
  --project <path>       only imported threads in this project
  --dry-run              list them, delete nothing

Everywhere
  --force                write even if T3's schema drifted from the baseline
  -h, --help             this text

T3 Code must be quit before writing: it only folds new events in at startup.
`;
