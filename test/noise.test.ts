import { expect, test, describe } from "bun:test";
import type { Session, Turn } from "../src/session.ts";
import { isNoise, MIN_CONVERSATION } from "../src/noise.ts";

const turn = (role: Turn["role"], text: string): Turn => ({ role, text, createdAt: "2026-09-30T00:00:00Z" });

const session = (...turns: Turn[]): Session => ({
  provider: "codex",
  sessionId: "01a0e207-9cba-7af3-89d2-5f376c15070c",
  path: "/x/s.jsonl",
  title: "",
  model: null,
  cwd: null,
  turns,
  stat: { size: 0, mtimeMs: 0, dev: 0, ino: 0 },
  generated: 0,
});

const PREAMBLE = `# AGENTS.md instructions for /repo\n\n${"guidance ".repeat(300)}`;

describe("noise", () => {
  test("a Codex preamble does not make a conversation a command record", () => {
    // 01a0e207: Codex opens with AGENTS.md as a user turn, and judging by the first turn
    // once hid this and 78 other real conversations.
    expect(
      isNoise(
        session(
          turn("user", PREAMBLE),
          turn("user", "Planning to put graphify to the repo. what do you think?"),
          turn("assistant", "I think this repo is a good Graphify candidate, introduced as an option. ".repeat(3)),
        ),
      ),
    ).toBe(false);
  });

  test("a session of only commands is noise, however long", () => {
    expect(
      isNoise(
        session(
          turn("user", "<command-name>/clear</command-name>"),
          turn("user", "<local-command-stdout>" + "x".repeat(5000)),
        ),
      ),
    ).toBe(true);
  });

  test("a preamble alone is noise: its size is not conversation", () => {
    expect(isNoise(session(turn("user", PREAMBLE), turn("assistant", "Ready.")))).toBe(true);
  });

  test("prompts T3 sends for itself are noise", () => {
    for (const text of [
      "You generate concise git branch names. Return a JSON object",
      "Generate a title that will help the user recognize this thread",
      "Generate a title that will help the user recognise this thread",
    ]) {
      expect(isNoise(session(turn("user", text), turn("assistant", "x".repeat(400))))).toBe(true);
    }
  });

  test("too little conversation is noise, even with a long greeting reply", () => {
    expect(isNoise(session(turn("user", "hi"), turn("assistant", "Hello! How can I help?")))).toBe(true);
  });

  test("a short but real exchange clears the size bar", () => {
    const ask = "set nvm default to 22.14.0";
    const reply = "x".repeat(MIN_CONVERSATION - ask.length);
    expect(isNoise(session(turn("user", ask), turn("assistant", reply)))).toBe(false);
  });

  test("no user turn at all is noise", () => {
    expect(isNoise(session(turn("assistant", "x".repeat(1000))))).toBe(true);
  });
});
