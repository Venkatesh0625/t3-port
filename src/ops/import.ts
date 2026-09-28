import type { Database } from "bun:sqlite";
import { resolve as resolvePath, sep } from "node:path";
import type { SessionStore } from "../claude/store.ts";
import { FALLBACK_MODEL, hasUserTurn, type Transcript } from "../claude/transcript.ts";
import { impliedRepoName, repoRootOf } from "../claude/worktree.ts";
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
  | "no-project"
  | "other-project";

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
  /** A project that probably owns this session, when we can only guess. */
  readonly suggestion?: string;
}

export interface Plan {
  readonly planned: readonly Planned[];
  readonly skipped: readonly Skipped[];
}

export interface PlanOptions {
  /**
   * Restrict the import to one project, by id, title, or workspace root.
   *
   * This filters rather than redirects: a session is imported only when its own working
   * directory falls under the named project. Redirecting every session into one project is a
   * separate, explicit choice — see `forceProject`.
   */
  readonly project?: string;
  /** Redirect sessions into the named project regardless of where they ran. */
  readonly forceProject?: boolean;
  readonly createProject?: boolean;
}

const under = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The most specific project directly containing a directory. */
function directlyEnclosing(all: readonly Project[], cwd: string): Project | null {
  const hits = all.filter((p) => under(cwd, p.workspaceRoot));
  if (hits.length === 0) return null;
  return hits.reduce((best, p) => (p.workspaceRoot.length > best.workspaceRoot.length ? p : best));
}

/**
 * The project owning a session's directory, following a worktree back to its repository.
 *
 * Only git is trusted here: a live worktree resolves to its real main checkout. A deleted one
 * can only be guessed from the path shape, which is offered as a suggestion instead.
 */
function enclosing(all: readonly Project[], cwd: string): Project | null {
  const direct = directlyEnclosing(all, cwd);
  if (direct) return direct;
  const repoRoot = repoRootOf(cwd);
  return repoRoot ? directlyEnclosing(all, repoRoot) : null;
}

/** A project whose directory name matches the repository a dead worktree path implies. */
function suggestFor(all: readonly Project[], cwd: string | null): string | undefined {
  if (!cwd) return undefined;
  const name = impliedRepoName(cwd);
  if (!name) return undefined;
  const matches = all.filter((p) => p.workspaceRoot.split(sep).pop() === name);
  return matches.length === 1 ? matches[0]!.workspaceRoot : undefined;
}

const expand = (path: string): string => resolvePath(path.replace(/^~/, process.env.HOME ?? "~"));

function named(all: readonly Project[], ref: string): Project | { workspaceRoot: string } {
  const root = expand(ref);
  return (
    all.find((p) => p.id === ref || p.title === ref || p.workspaceRoot === root) ?? { workspaceRoot: root }
  );
}

function asNew(workspaceRoot: string): Planned["project"] {
  return { create: true, workspaceRoot, title: workspaceRoot.split(sep).pop() || workspaceRoot };
}

function targetProject(
  all: readonly Project[],
  transcript: Transcript,
  options: PlanOptions,
): Planned["project"] | "out-of-scope" | null {
  if (options.project) {
    const target = named(all, options.project);

    // Explicit redirect: every session goes here, wherever it ran.
    if (options.forceProject) {
      if ("id" in target) return target;
      return options.createProject ? asNew(target.workspaceRoot) : null;
    }

    // Default: a named project scopes the import to sessions that actually ran under it.
    if (!transcript.cwd || !under(transcript.cwd, target.workspaceRoot)) return "out-of-scope";
    if ("id" in target) return target;
    return options.createProject ? asNew(target.workspaceRoot) : null;
  }

  if (!transcript.cwd) return null;
  const found = enclosing(all, transcript.cwd);
  if (found) return found;
  return options.createProject ? asNew(transcript.cwd) : null;
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
    if (project === "out-of-scope") {
      skipped.push({ transcript, reason: "other-project" });
      continue;
    }
    if (!project) {
      skipped.push({ transcript, reason: "no-project", suggestion: suggestFor(all, transcript.cwd) });
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
