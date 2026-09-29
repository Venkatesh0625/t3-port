import type { Database } from "bun:sqlite";
import { resolve as resolvePath } from "node:path";
import type { Config } from "../config.ts";
import { byId, type Provider } from "../providers/index.ts";
import { hasUserTurn, type Session } from "../session.ts";
import { isNoise } from "../noise.ts";
import { nowIso } from "../time.ts";
import { enclosing, nameOf, suggest, under } from "./locate.ts";
import {
  bindSession,
  importedThreadId,
  projectCreate,
  threadCreate,
  threadHistoryImport,
  threadUnsettle,
} from "../t3/commands.ts";
import { EventLog } from "../t3/eventlog.ts";
import {
  importedSessionIds,
  nativeSessionIds,
  ownersBySession,
  projects,
  type Owner,
  type Project,
} from "../t3/queries.ts";

export type SkipReason =
  | "no-user-turn"
  | "unresumable-session-id"
  | "already-imported"
  | "t3-native"
  | "no-project"
  | "other-project"
  | "in-progress"
  | "noise";

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
  /** The thread that already holds this conversation, when one does. */
  readonly owner?: Owner;
}

export interface Plan {
  readonly planned: readonly Planned[];
  readonly skipped: readonly Skipped[];
}

/**
 * How recently a transcript must have changed to be treated as still running.
 *
 * An import is a snapshot. If the agent writes another turn afterwards, the thread keeps the
 * resume cursor — so continuing it in T3 gives the model the whole conversation while the thread
 * shows only what existed at import time, and nothing can reconcile the two: the session is
 * already marked imported. Two minutes is long enough to cover a slow turn without holding back
 * a session that genuinely finished.
 */
export const LIVE_WINDOW_MS = 120_000;

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
  /** Import sessions that still look like they are running. */
  readonly includeLive?: boolean;
  /** Import command records and one-line sessions too. */
  readonly includeNoise?: boolean;
  /**
   * Import a session even though a T3 thread already resumes it.
   *
   * Two threads on one provider session both write to its transcript, which is why this is not
   * the default. It is the right call when the thread that claims a conversation was deleted or
   * archived and the conversation is wanted back — and whether that is so is the user's to say,
   * not something to infer from a binding.
   */
  readonly reclaim?: boolean;
  /** Overridable for tests. */
  readonly now?: number;
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

function classify(
  session: Session,
  provider: Provider,
  known: Known,
  options: PlanOptions,
): SkipReason | null {
  if (!provider.isResumable(session.sessionId)) return "unresumable-session-id";
  if (!hasUserTurn(session)) return "no-user-turn";
  if (known.imported.has(session.sessionId)) return "already-imported";
  // Only a binding says a thread holds this session. Where a session ran used to say it too —
  // anything under T3's worktrees was assumed to be T3's — but running `claude` by hand inside
  // a worktree produces a session T3 never started, and the guess then claimed a conversation
  // no thread held. Bindings answer the question the guess was approximating.
  if (!options.reclaim && known.native.has(session.sessionId)) return "t3-native";
  if (!options.includeNoise && isNoise(session)) return "noise";
  if (!options.includeLive) {
    const age = (options.now ?? Date.now()) - session.stat.mtimeMs;
    if (age >= 0 && age < LIVE_WINDOW_MS) return "in-progress";
  }
  return null;
}

export function plan(
  db: Database,
  sessions: readonly Session[],
  options: PlanOptions,
  worktrees: string,
): Plan {
  const all = projects(db);
  const owners = ownersBySession(db);
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

    const reason = classify(session, provider, known(provider), options);
    if (reason) {
      const owner = owners.get(session.sessionId);
      skipped.push(owner ? { session, reason, owner } : { session, reason });
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

interface Pending extends Imported {
  readonly toPlace: { provider: Provider; from: string } | null;
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
export interface ApplyOptions {
  /** Leave imported threads settled, the way T3's own first-run import does. */
  readonly settled?: boolean;
}

export function apply(
  db: Database,
  config: Config,
  plan: Plan,
  options: ApplyOptions = {},
  now = nowIso(),
): ImportOutcome {
  const log = new EventLog(db);
  const created = new Map<string, Project>();
  const results: Pending[] = [];

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
      // The history import settles the thread; unless asked otherwise, bring it back so it
      // appears where someone continuing the conversation would look for it.
      if (!options.settled) log.append(threadUnsettle(threadId, now));

      results.push({
        threadId,
        title: session.title,
        turns: session.turns.length,
        workspaceRoot: project.workspaceRoot,
        placedAt: null,
        toPlace: item.needsPlacing ? { provider, from: session.path } : null,
      });
    }
  })();

  // Copies happen after the transaction commits. A rollback can undo rows; it cannot undo a
  // file, so placing a transcript first would leave one behind whenever an import failed.
  const placed = results.map(({ toPlace, ...thread }) => ({
    ...thread,
    placedAt: toPlace ? toPlace.provider.place(config, toPlace.from, thread.workspaceRoot) : null,
  }));

  return { runId: log.run, threads: placed };
}
