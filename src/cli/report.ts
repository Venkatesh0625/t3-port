import type { Plan, SkipReason } from "../ops/import.ts";
import { isNew } from "../ops/import.ts";
import type { ImportedThread } from "../t3/queries.ts";
import type { Session } from "../session.ts";
import { describeLocation, formatLocation } from "./location.ts";
import { color, pad } from "./color.ts";
import { MAX_TRANSCRIPT_BYTES } from "../session.ts";
import { abbreviate } from "./abbrev.ts";

const SKIP_LABEL: Record<SkipReason, string> = {
  "no-user-turn": "no user turn",
  "unresumable-session-id": "session id T3 cannot resume",
  "already-imported": "already imported",
  "t3-native": "started by T3",
  "no-project": "no project covers its directory",
  "other-project": "ran outside the named project",
  "in-progress": "still running (--include-live to import anyway)",
  noise: "a command or one-liner (--include-noise to import anyway)",
};


/** Beyond this the column crowds out the title. */
export const MAX_PROJECT_WIDTH = 34;
const TITLE_WIDTH = 46;

export interface Listed {
  readonly session: Session;
  readonly mark: string;
  /** The project this session would import into, or null when none covers it. */
  readonly project: string | null;
}

/** Where a row ran, as it will be printed. */
export const locationOf = (row: Listed): string =>
  formatLocation(describeLocation(row.session.cwd, row.project));

/** Wide enough for the longest location on show, and no wider. */
export const projectWidth = (rows: readonly Listed[]): number =>
  Math.min(
    MAX_PROJECT_WIDTH,
    rows.reduce((n, row) => Math.max(n, locationOf(row).length), "project".length),
  );

export function sessionHeader(idWidth: number, projectWidth: number): string {
  return color.dim(
    `${"".padEnd(9)} ${"agent".padEnd(6)} ${"session".padEnd(idWidth)}  ${"turns".padStart(5)}  ` +
      `${"project".padEnd(projectWidth)}  title`,
  );
}

/** Status reads at a glance: green is in T3, dim is T3's own, plain is yours to import. */
function markup(mark: string): string {
  if (mark === "imported") return color.green(mark);
  if (mark === "t3") return color.dim(mark);
  return color.dim("-");
}

export function sessionLine(
  row: Listed,
  label: (s: Session) => string,
  id: (sessionId: string) => string,
  width: number,
): string {
  const { session } = row;
  const shown = formatLocation(describeLocation(session.cwd, row.project), width);
  // The column describes where a session ran, which the path always answers — so it is dim only
  // when there is no path at all. Whether a project covers it is the import plan's business,
  // not a colour here: a worktree whose directory is gone still ran somewhere worth naming.
  const known = shown !== "NA";

  return (
    `${pad(markup(row.mark), 9)} ${color.dim(pad(label(session), 6))} ${color.dim(id(session.sessionId))}  ` +
    `${pad(String(session.turns.length), 5, "right")}  ` +
    `${pad(known ? color.cyan(shown) : color.dim(shown), width)}  ` +
    session.title.slice(0, TITLE_WIDTH)
  );
}

export function planSummary(plan: Plan): string {
  const counts = new Map<SkipReason, number>();
  for (const s of plan.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);

  const id = abbreviate([...plan.planned, ...plan.skipped].map((i) => i.session.sessionId)).of;
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
      `  ${id(item.session.sessionId)}  ${String(item.session.turns.length).padStart(4)} turns  ` +
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
      lines.push(`  ${id(s.session.sessionId)}  ${s.session.cwd}`);
      lines.push(`            probably ${s.suggestion} — confirm with --project`);
    }
  }
  return lines.join("\n");
}

export function threadList(threads: readonly ImportedThread[], limit = 15): string {
  const id = abbreviate(threads.map((t) => t.sessionId ?? t.threadId)).of;
  const lines = threads
    .slice(0, limit)
    .map((t) => `  ${id(t.sessionId ?? t.threadId)}  ${t.title.slice(0, 60)}`);
  if (threads.length > limit) lines.push(`  ... ${threads.length - limit} more`);
  return lines.join("\n");
}

const MAX_MB = MAX_TRANSCRIPT_BYTES / 1048576;

/** One line for transcripts too large to read, rather than one line each. */
export function tooLargeNote(skipped: readonly { bytes: number }[]): string | null {
  if (skipped.length === 0) return null;
  const mb = Math.round(skipped.reduce((n, s) => Math.max(n, s.bytes), 0) / 1048576);
  return color.dim(
    `${skipped.length} transcript(s) skipped, up to ${mb} MB — past the ${MAX_MB} MB read limit.`,
  );
}
