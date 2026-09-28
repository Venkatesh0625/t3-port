import { expect, test, describe } from "bun:test";
import { resumeCursor, importedThreadId, CODEX_INSTANCE, CLAUDE_INSTANCE } from "../src/t3/commands.ts";
import { isGenerated } from "../src/codex/rollout.ts";
import { RolloutStore } from "../src/codex/store.ts";

describe("resume cursors differ per provider (AgentSessionImporter.ts:234)", () => {
  test("Claude carries both the thread and the session it resumes", () => {
    expect(resumeCursor(CLAUDE_INSTANCE, "import:claudeAgent:s", "s")).toEqual({
      threadId: "import:claudeAgent:s",
      resume: "s",
    });
  });

  test("Codex stores only its own thread id, with no resume key", () => {
    const cursor = resumeCursor(CODEX_INSTANCE, "import:codex:s", "s") as Record<string, unknown>;
    expect(cursor).toEqual({ threadId: "s" });
    // Writing Claude's shape here would leave the session unresumable.
    expect(cursor).not.toHaveProperty("resume");
  });
});

test("thread ids are namespaced per provider, so ids cannot collide", () => {
  expect(importedThreadId("s", CODEX_INSTANCE)).toBe("import:codex:s");
  expect(importedThreadId("s", CLAUDE_INSTANCE)).toBe("import:claudeAgent:s");
});

describe("rollout filenames", () => {
  test("session id is the uuid, not the leading timestamp", () => {
    expect(
      RolloutStore.sessionIdOf(
        "/x/sessions/2026/09/28/rollout-2026-09-28T15-32-04-01a0e776-e594-7722-86ec-c75d00d64a29.jsonl",
      ),
    ).toBe("01a0e776-e594-7722-86ec-c75d00d64a29");
  });

  test("unrelated files are not sessions", () => {
    expect(RolloutStore.sessionIdOf("/x/history.jsonl")).toBeNull();
    expect(RolloutStore.sessionIdOf("/x/session_index.jsonl")).toBeNull();
  });
});

describe("Codex-generated preamble", () => {
  test("recognises what Codex injects as user turns", () => {
    expect(isGenerated("# AGENTS.md instructions for /repo\n<INSTRUCTIONS>")).toBe(true);
    expect(isGenerated("<environment_context>")).toBe(true);
    expect(isGenerated("<turn_aborted>")).toBe(true);
  });

  test("leaves real prompts alone", () => {
    expect(isGenerated("check what was this about")).toBe(false);
    expect(isGenerated("read AGENTS.md and tell me the rules")).toBe(false);
  });
});
