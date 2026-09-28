import type { Plan, SkipReason } from "../ops/import.ts";
import { isNew } from "../ops/import.ts";
import type { ImportedThread } from "../t3/queries.ts";
import type { Session } from "../session.ts";
import { shortPath } from "./paths.ts";
import { color, pad } from "./color.ts";

const SKIP_LABEL: Record<SkipReason, string> = {
  "no-user-turn": "no user turn",
  "unresumable-session-id": "session id T3 cannot resume",
  "already-imported": "already imported",
  "t3-native": "started by T3",
  "no-project": "no project covers its directory",
  "other-project": "ran outside the named project",
};

const short = (id: string): string => id.slice(0, 8);

const PROJECT_WIDTH = 26;
const TITLE_WIDTH = 46;

export interface Listed {
  readonly session: Session;
  readonly mark: string;
  /** The project this session would import into, or null when none covers it. */
  readonly project: string | null;
}

export function sessionHeader(): string {
  return color.dim(
    `${"".padEnd(9)} ${"agent".padEnd(6)} ${"session".padEnd(8)}  ${"turns".padStart(5)}  ` +
      `${"project".padEnd(PROJECT_WIDTH)}  title`,
  );
}

/** Status reads at a glance: green is in T3, dim is T3's own, plain is yours to import. */
function markup(mark: string): string {
  if (mark === "imported") return color.green(mark);
  if (mark === "t3") return color.dim(mark);
  return color.dim("-");
}

export function sessionLine(row: Listed, label: (s: Session) => string): string {
  const { session } = row;
  // An unplaced session shows where it ran instead: that is usually why it is unplaced.
  const placed = row.project !== null;
  const where = row.project ?? session.cwd;
  const project = where
    ? shortPath(where, PROJECT_WIDTH)
    : "—";

  return (
    `${pad(markup(row.mark), 9)} ${color.dim(pad(label(session), 6))} ${color.dim(short(session.sessionId))}  ` +
    `${pad(String(session.turns.length), 5, "right")}  ` +
    `${pad(placed ? color.cyan(project) : color.dim(project), PROJECT_WIDTH)}  ` +
    session.title.slice(0, TITLE_WIDTH)
  );
}

export function planSummary(plan: Plan): string {
  const counts = new Map<SkipReason, number>();
  for (const s of plan.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);

  const lines = [
    `${color.bold(String(plan.planned.length))} to import, ${plan.skipped.length} skipped`,
  ];
  for (const [reason, n] of counts) {
    lines.push(color.dim(`  ${String(n).padStart(4)}  ${SKIP_LABEL[reason]}`));
  }

  if (plan.planned.length > 0) lines.push("");
  for (const item of plan.planned) {
    const root = isNew(item.target) ? `${item.target.workspaceRoot} (new)` : item.target.workspaceRoot;
    lines.push(
      `  ${short(item.session.sessionId)}  ${String(item.session.turns.length).padStart(4)} turns  ` +
        item.session.title.slice(0, 44),
    );
    lines.push(
      color.dim("            -> ") +
        color.cyan(root) +
        (item.needsPlacing ? color.dim("  [transcript placed]") : ""),
    );
  }

  const suggestions = plan.skipped.filter((s) => s.suggestion);
  if (suggestions.length > 0) {
    lines.push("", color.yellow(`${suggestions.length} session(s) look like worktrees of a project you have:`));
    for (const s of suggestions.slice(0, 5)) {
      lines.push(`  ${short(s.session.sessionId)}  ${s.session.cwd}`);
      lines.push(`            probably ${s.suggestion} — confirm with --project`);
    }
  }
  return lines.join("\n");
}

export function threadList(threads: readonly ImportedThread[], limit = 15): string {
  const lines = threads
    .slice(0, limit)
    .map((t) => `  ${short(t.sessionId ?? t.threadId)}  ${t.title.slice(0, 60)}`);
  if (threads.length > limit) lines.push(`  ... ${threads.length - limit} more`);
  return lines.join("\n");
}
