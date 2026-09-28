import type { Plan, SkipReason } from "../ops/import.ts";
import { isNew } from "../ops/import.ts";
import type { ImportedThread } from "../t3/queries.ts";
import type { Session } from "../session.ts";

const SKIP_LABEL: Record<SkipReason, string> = {
  "no-user-turn": "no user turn",
  "unresumable-session-id": "session id T3 cannot resume",
  "already-imported": "already imported",
  "t3-native": "started by T3",
  "no-project": "no project covers its directory",
  "other-project": "ran outside the named project",
};

const short = (id: string): string => id.slice(0, 8);

export function sessionLine(session: Session, mark: string): string {
  return (
    `${mark.padEnd(9)} ${session.provider === "codex" ? "codex " : "claude"} ${short(session.sessionId)}  ` +
    `${String(session.turns.length).padStart(4)} turns  ${session.title.slice(0, 48)}`
  );
}

export function planSummary(plan: Plan): string {
  const counts = new Map<SkipReason, number>();
  for (const s of plan.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);

  const lines = [`${plan.planned.length} to import, ${plan.skipped.length} skipped`];
  for (const [reason, n] of counts) lines.push(`  ${String(n).padStart(4)}  ${SKIP_LABEL[reason]}`);

  if (plan.planned.length > 0) lines.push("");
  for (const item of plan.planned) {
    const root = isNew(item.target) ? `${item.target.workspaceRoot} (new)` : item.target.workspaceRoot;
    lines.push(
      `  ${short(item.session.sessionId)}  ${String(item.session.turns.length).padStart(4)} turns  ` +
        item.session.title.slice(0, 44),
    );
    lines.push(`            -> ${root}${item.needsPlacing ? "  [transcript placed]" : ""}`);
  }

  const suggestions = plan.skipped.filter((s) => s.suggestion);
  if (suggestions.length > 0) {
    lines.push("", `${suggestions.length} session(s) look like worktrees of a project you have:`);
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
