import type { Session } from "./session.ts";

/**
 * Sessions that are records of an action rather than a conversation.
 *
 * A listing is mostly these: `/clear`, `/login`, the prompt T3 sends to name a workspace, a
 * one-line "hi". They are real sessions and nothing here deletes them, but they crowd out the
 * conversations someone is actually looking for, and importing them fills T3 with threads no
 * one will open.
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
  /^Generate a title that will help the user recognise/i,
  /^The following is the Codex agent history/,
];

const MAX_NOISE_TURNS = 2;

export function isNoise(session: Session): boolean {
  const opening = session.turns.find((turn) => turn.role === "user");
  if (!opening) return true;
  if (MACHINERY.some((pattern) => pattern.test(opening.text))) return true;
  // A couple of turns with nothing but a greeting is not a conversation worth carrying over.
  return session.turns.length <= MAX_NOISE_TURNS && opening.text.length < 24;
}
