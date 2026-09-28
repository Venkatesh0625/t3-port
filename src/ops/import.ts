import type { Database } from "bun:sqlite";
import { resolve as resolvePath, sep } from "node:path";
import type { SessionStore } from "../claude/store.ts";
import { FALLBACK_MODEL, hasUserTurn, type Transcript } from "../claude/transcript.ts";
import { nowIso } from "../time.ts";
import {
  CLAUDE_SESSION_ID,
  bindClaudeSession,
  importedThreadId,
  projectCreate,
  threadCreate,
  threadHistoryImport,
} from "../t3/commands.ts";
import { EventLog } from "../t3/eventlog.ts";
import { importedSessionIds, nativeSessionIds, projects, type Project } from "../t3/queries.ts";

export type SkipReason =
  | "no-user-turn"
  | "unresumable-session-id"
  | "already-imported"
  | "t3-native"
  | "no-project";

export interface Planned {
  readonly transcript: Transcript;
  readonly project: Project | { create: true; workspaceRoot: string; title: string };
  readonly threadId: string;
  /** True when the transcript must be copied so `claude --resume` finds it at the project root. */
  readonly needsCopy: boolean;
}

export interface Skipped {
  readonly transcript: Transcript;
  readonly reason: SkipReason;
}

export interface Plan {
  readonly planned: readonly Planned[];
  readonly skipped: readonly Skipped[];
}

export interface PlanOptions {
  /** Force a target project by id, title, or workspace root. */
  readonly project?: string;
  readonly createProject?: boolean;
}

const under = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The most specific project containing a directory. */
function enclosing(all: readonly Project[], cwd: string): Project | null {
  const hits = all.filter((p) => under(cwd, p.workspaceRoot));
  if (hits.length === 0) return null;
  return hits.reduce((best, p) => (p.workspaceRoot.length > best.workspaceRoot.length ? p : best));
}

function targetProject(
  all: readonly Project[],
  transcript: Transcript,
  options: PlanOptions,
): Planned["project"] | null {
  if (options.project) {
    const root = resolvePath(options.project.replace(/^~/, process.env.HOME ?? "~"));
    const found = all.find(
      (p) => p.id === options.project || p.title === options.project || p.workspaceRoot === root,
    );
    if (found) return found;
    return options.createProject
      ? { create: true, workspaceRoot: root, title: root.split(sep).pop() || root }
      : null;
  }
  if (!transcript.cwd) return null;
  const found = enclosing(all, transcript.cwd);
  if (found) return found;
  return options.createProject
    ? { create: true, workspaceRoot: transcript.cwd, title: transcript.cwd.split(sep).pop() || transcript.cwd }
    : null;
}

function classify(
  transcript: Transcript,
  native: ReadonlySet<string>,
  imported: ReadonlySet<string>,
  worktrees: string,
): SkipReason | null {
  // T3 refuses to resume a session id it cannot parse, so importing one would strand the thread.
  if (!CLAUDE_SESSION_ID.test(transcript.sessionId)) return "unresumable-session-id";
  if (!hasUserTurn(transcript)) return "no-user-turn";
  if (imported.has(transcript.sessionId)) return "already-imported";
  if (native.has(transcript.sessionId)) return "t3-native";
  if (transcript.cwd && under(transcript.cwd, worktrees)) return "t3-native";
  return null;
}

export function plan(
  db: Database,
  transcripts: readonly Transcript[],
  options: PlanOptions,
  worktrees: string,
): Plan {
  const all = projects(db);
  const native = nativeSessionIds(db);
  const imported = importedSessionIds(db);
  const planned: Planned[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();

  for (const transcript of transcripts) {
    if (seen.has(transcript.sessionId)) continue;
    seen.add(transcript.sessionId);

    const reason = classify(transcript, native, imported, worktrees);
    if (reason) {
      skipped.push({ transcript, reason });
      continue;
    }
    const project = targetProject(all, transcript, options);
    if (!project) {
      skipped.push({ transcript, reason: "no-project" });
      continue;
    }
    const root = "create" in project ? project.workspaceRoot : project.workspaceRoot;
    planned.push({
      transcript,
      project,
      threadId: importedThreadId(transcript.sessionId),
      needsCopy: transcript.cwd !== root,
    });
  }
  return { planned, skipped };
}

export interface Imported {
  readonly threadId: string;
  readonly title: string;
  readonly turns: number;
  readonly workspaceRoot: string;
  readonly copiedTo: string | null;
}

/**
 * Apply a plan in one transaction.
 *
 * Order matters: the resume cursor goes in before the thread's events, so a thread is never
 * visible without the binding that lets it continue its Claude session.
 */
export function apply(db: Database, store: SessionStore, plan: Plan, now = nowIso()): Imported[] {
  const log = new EventLog(db);
  const created = new Map<string, Project>();
  const results: Imported[] = [];

  db.transaction(() => {
    for (const item of plan.planned) {
      let project: Project;
      if ("create" in item.project) {
        const key = item.project.workspaceRoot;
        const existing = created.get(key);
        if (existing) {
          project = existing;
        } else {
          const { projectId, command } = projectCreate({
            title: item.project.title,
            workspaceRoot: key,
            now,
          });
          log.append(command);
          project = { id: projectId, title: item.project.title, workspaceRoot: key };
          created.set(key, project);
        }
      } else {
        project = item.project;
      }

      const { transcript, threadId } = item;
      const copiedTo = item.needsCopy ? store.copyUnder(transcript.path, project.workspaceRoot) : null;

      bindClaudeSession(db, {
        threadId,
        sessionId: transcript.sessionId,
        cwd: project.workspaceRoot,
        source: {
          filePath: transcript.path,
          size: transcript.stat.size,
          mtimeMs: transcript.stat.mtimeMs,
          device: transcript.stat.dev,
          inode: transcript.stat.ino,
        },
        now,
      });

      const openedAt = transcript.turns[0]!.createdAt;
      log.append(
        threadCreate({
          threadId,
          projectId: project.id,
          title: transcript.title,
          model: transcript.model ?? FALLBACK_MODEL,
          createdAt: openedAt,
        }),
      );
      log.append(threadHistoryImport(threadId, transcript.turns));

      results.push({
        threadId,
        title: transcript.title,
        turns: transcript.turns.length,
        workspaceRoot: project.workspaceRoot,
        copiedTo,
      });
    }
  })();

  return results;
}
