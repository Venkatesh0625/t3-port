import type { Session } from "./session.ts";

/**
 * Sessions that are records of an action rather than a conversation.
 *
 * A listing is mostly these: `/clear`, `/login`, the prompt T3 sends to name a workspace, a
 * one-line "hi". They are real sessions and nothing here deletes them, but they crowd out the
 * conversations someone is actually looking for, and importing them fills T3 with threads no
 * one will open.
 *
 * Decided by what the person wrote and how much conversation came of it — never by the first
 * turn alone. Codex opens every session with its AGENTS.md preamble as a user turn, and judging
 * by that turn once marked 79 real conversations as command records.
 */

/** A turn the user did not write: a slash command, or text an agent generated for itself. */
const MACHINERY = [
  /^<command-(name|message|args)>/,
  /^<local-command-/,
  /^# AGENTS\.md instructions for /,
  /^<environment_context>/,
  /^<recommended_plugins>/,
  /^<turn_aborted>/,
  /^<user_instructions>/,
  /^You name new code workspaces from the user's initial prompt\./,
  /^You generate concise git branch names\./,
  /^Generate a title that will help the user recogni[sz]e/i,
  /^The following is the Codex agent history/,
];

/**
 * Characters of conversation below which there is nothing worth a thread.
 *
 * Measured on 309 local sessions: everything at or under 102 was a greeting, a typo, or a
 * "reply with just the number" probe; the next was 196 and a real, if short, request.
 */
export const MIN_CONVERSATION = 150;

const written = (text: string): boolean => !MACHINERY.some((pattern) => pattern.test(text));

export function isNoise(session: Session): boolean {
  const turns = session.turns.filter((turn) => turn.role !== "user" || written(turn.text));
  if (!turns.some((turn) => turn.role === "user")) return true;
  return turns.reduce((n, turn) => n + turn.text.length, 0) < MIN_CONVERSATION;
}
