import { expect, test, describe } from "bun:test";
import { PROVIDERS, byId } from "../src/providers/index.ts";
import { claude } from "../src/providers/claude.ts";
import { codex, sessionIdOf } from "../src/providers/codex.ts";
import { prose } from "../src/providers/claude.transcript.ts";
import { isGenerated } from "../src/providers/codex.rollout.ts";

describe("resume cursors differ per provider (AgentSessionImporter.ts:234)", () => {
  test("Claude carries both the thread and the session it resumes", () => {
    expect(claude.resumeCursor("import:claudeAgent:s", "s")).toEqual({
      threadId: "import:claudeAgent:s",
      resume: "s",
    });
  });

  test("Codex stores only its own thread id, with no resume key", () => {
    const cursor = codex.resumeCursor("import:codex:s", "s") as Record<string, unknown>;
    expect(cursor).toEqual({ threadId: "s" });
    // Writing Claude's shape here would leave the session unresumable.
    expect(cursor).not.toHaveProperty("resume");
  });

  test("each provider reads its own id back out of a stored cursor", () => {
    expect(claude.sessionIdFromCursor({ threadId: "t", resume: "s" })).toBe("s");
    expect(codex.sessionIdFromCursor({ threadId: "s" })).toBe("s");
    expect(claude.sessionIdFromCursor({ threadId: "s" })).toBeNull();
  });
});

describe("registry", () => {
  test("ids and labels are unique, so flags cannot collide", () => {
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
    expect(new Set(PROVIDERS.map((p) => p.label)).size).toBe(PROVIDERS.length);
  });

  test("lookup by id", () => {
    expect(byId("codex")).toBe(codex);
    expect(() => byId("nope")).toThrow(/unknown provider/);
  });

  test("only location-addressed providers place transcripts", () => {
    expect(claude.locationAddressed).toBe(true);
    expect(codex.locationAddressed).toBe(false);
    expect(codex.place({} as never, "/x.jsonl", "/tmp")).toBeNull();
  });
});

describe("session ids", () => {
  test("Claude only accepts ids T3 can resume", () => {
    expect(claude.isResumable("347cd91a-749f-4f92-a41d-4b8e82e158d9")).toBe(true);
    expect(claude.isResumable("not-a-uuid")).toBe(false);
    // version nibble must be 1-8, variant 8/9/a/b
    expect(claude.isResumable("347cd91a-749f-9f92-a41d-4b8e82e158d9")).toBe(false);
  });

  test("Codex ids come from metadata, so only emptiness disqualifies them", () => {
    expect(codex.isResumable("01a0e776-e594-7722-86ec-c75d00d64a29")).toBe(true);
    expect(codex.isResumable("")).toBe(false);
  });

  test("a rollout filename yields the uuid, not the leading timestamp", () => {
    expect(sessionIdOf("/x/rollout-2026-09-28T15-32-04-01a0e776-e594-7722-86ec-c75d00d64a29.jsonl")).toBe(
      "01a0e776-e594-7722-86ec-c75d00d64a29",
    );
    expect(sessionIdOf("/x/history.jsonl")).toBeNull();
  });
});

describe("transcript text extraction", () => {
  test("Claude keeps text blocks and drops tool noise", () => {
    expect(
      prose([
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "  visible  " },
        { type: "tool_use", name: "Bash" },
        { type: "tool_result", content: "output" },
        { type: "text", text: "second" },
      ]),
    ).toBe("visible\nsecond");
    expect(prose(" hi ")).toBe("hi");
    expect(prose([{ type: "tool_result", content: "x" }])).toBe("");
  });

  test("Codex preamble is recognised, real prompts are not", () => {
    expect(isGenerated("# AGENTS.md instructions for /repo")).toBe(true);
    expect(isGenerated("<environment_context>")).toBe(true);
    expect(isGenerated("check what was this about")).toBe(false);
    expect(isGenerated("read AGENTS.md and tell me the rules")).toBe(false);
  });
});
