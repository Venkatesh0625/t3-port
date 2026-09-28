import type { Database } from "bun:sqlite";
import { resolve as resolvePath } from "node:path";
import type { Config } from "../config.ts";
import { byId, type Provider } from "../providers/index.ts";
import { hasUserTurn, type Session } from "../session.ts";
import { nowIso } from "../time.ts";
import { enclosing, nameOf, suggest, under } from "./locate.ts";
import { bindSession, importedThreadId, projectCreate, threadCreate, threadHistoryImport } from "../t3/commands.ts";
import { EventLog } from "../t3/eventlog.ts";
import { importedSessionIds, nativeSessionIds, projects, type Project } from "../t3/queries.ts";

export type SkipReason =
  | "no-user-turn"
  | "unresumable-session-id"
  | "already-imported"
  | "t3-native"
  | "no-project"
  | "other-project";

/** A project that does not exist yet. */
export interface NewProject {
  readonly create: true;
  readonly workspaceRoot: string;
  readonly title: string;
}

export type Target = Project | NewProject;
export const isNew = (target: Target): target is NewProject => "create" in target;

export interface Planned {
  readonly session: Session;
  readonly target: Target;
  readonly threadId: string;
  /** The transcript must be placed at the project root for the agent to find it there. */
  readonly needsPlacing: boolean;
}

export interface Skipped {
  readonly session: Session;
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
   * directory falls under the named project. Redirecting everything into one project is a
   * separate, explicit choice — see `forceProject`.
   */
  readonly project?: string;
  /** Redirect sessions into the named project regardless of where they ran. */
  readonly forceProject?: boolean;
  readonly createProject?: boolean;
}

const expand = (path: string): string => resolvePath(path.replace(/^~/, process.env.HOME ?? "~"));

function targetFor(
  all: readonly Project[],
  session: Session,
  options: PlanOptions,
): Target | "out-of-scope" | null {
  if (options.project) {
    const root = expand(options.project);
    const named =
      all.find((p) => p.id === options.project || p.title === options.project || p.workspaceRoot === root) ??
      null;
    const workspaceRoot = named?.workspaceRoot ?? root;

    if (!options.forceProject && (!session.cwd || !under(session.cwd, workspaceRoot))) {
      return "out-of-scope";
    }
    if (named) return named;
    return options.createProject ? { create: true, workspaceRoot, title: nameOf(workspaceRoot) } : null;
  }

  if (!session.cwd) return null;
  const found = enclosing(all, session.cwd);
  if (found) return found;
  return options.createProject
    ? { create: true, workspaceRoot: session.cwd, title: nameOf(session.cwd) }
    : null;
}

interface Known {
  readonly native: ReadonlySet<string>;
  readonly imported: ReadonlySet<string>;
}

function classify(session: Session, provider: Provider, known: Known, worktrees: string): SkipReason | null {
  if (!provider.isResumable(session.sessionId)) return "unresumable-session-id";
  if (!hasUserTurn(session)) return "no-user-turn";
  if (known.imported.has(session.sessionId)) return "already-imported";
  if (known.native.has(session.sessionId)) return "t3-native";
  if (session.cwd && under(session.cwd, worktrees)) return "t3-native";
  return null;
}

export function plan(
  db: Database,
  sessions: readonly Session[],
  options: PlanOptions,
  worktrees: string,
): Plan {
  const all = projects(db);
  // Each provider has its own id space and cursor shape, so look them up separately.
  const cache = new Map<string, Known>();
  const known = (provider: Provider): Known => {
    let entry = cache.get(provider.id);
    if (!entry) {
      entry = { native: nativeSessionIds(db, provider), imported: importedSessionIds(db, provider) };
      cache.set(provider.id, entry);
    }
    return entry;
  };

  const planned: Planned[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();

  for (const session of sessions) {
    const provider = byId(session.provider);
    const key = `${provider.id}:${session.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const reason = classify(session, provider, known(provider), worktrees);
    if (reason) {
      skipped.push({ session, reason });
      continue;
    }

    const target = targetFor(all, session, options);
    if (target === "out-of-scope") {
      skipped.push({ session, reason: "other-project" });
      continue;
    }
    if (!target) {
      skipped.push({ session, reason: "no-project", suggestion: suggest(all, session.cwd)?.workspaceRoot });
      continue;
    }

    planned.push({
      session,
      target,
      threadId: importedThreadId(session.sessionId, provider.id),
      needsPlacing: provider.locationAddressed && session.cwd !== target.workspaceRoot,
    });
  }
  return { planned, skipped };
}

export interface ImportOutcome {
  /** Ties every event this run wrote together, so the run can be undone as a unit. */
  readonly runId: string;
  readonly threads: readonly Imported[];
}

export interface Imported {
  readonly threadId: string;
  readonly title: string;
  readonly turns: number;
  readonly workspaceRoot: string;
  readonly placedAt: string | null;
}

/**
 * Apply a plan in one transaction.
 *
 * Order matters: the resume cursor goes in before the thread's events, so a thread is never
 * visible without the binding that lets it continue its session.
 */
export function apply(db: Database, config: Config, plan: Plan, now = nowIso()): ImportOutcome {
  const log = new EventLog(db);
  const created = new Map<string, Project>();
  const results: Imported[] = [];

  db.transaction(() => {
    for (const item of plan.planned) {
      const provider = byId(item.session.provider);

      let project: Project;
      if (isNew(item.target)) {
        const existing = created.get(item.target.workspaceRoot);
        if (existing) {
          project = existing;
        } else {
          const { projectId, command } = projectCreate({
            title: item.target.title,
            workspaceRoot: item.target.workspaceRoot,
            now,
          });
          log.append(command);
          project = { id: projectId, title: item.target.title, workspaceRoot: item.target.workspaceRoot };
          created.set(project.workspaceRoot, project);
        }
      } else {
        project = item.target;
      }

      const { session, threadId } = item;
      const placedAt = item.needsPlacing ? provider.place(config, session.path, project.workspaceRoot) : null;

      bindSession(db, {
        provider,
        threadId,
        sessionId: session.sessionId,
        cwd: project.workspaceRoot,
        source: {
          filePath: session.path,
          size: session.stat.size,
          mtimeMs: session.stat.mtimeMs,
          device: session.stat.dev,
          inode: session.stat.ino,
        },
        now,
      });

      log.append(
        threadCreate({
          threadId,
          projectId: project.id,
          title: session.title,
          model: session.model ?? provider.fallbackModel,
          providerId: provider.id,
          createdAt: session.turns[0]!.createdAt,
        }),
      );
      log.append(threadHistoryImport(threadId, session.turns));

      results.push({
        threadId,
        title: session.title,
        turns: session.turns.length,
        workspaceRoot: project.workspaceRoot,
        placedAt,
      });
    }
  })();

  return { runId: log.run, threads: results };
}
