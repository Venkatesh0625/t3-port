import { expect, test, describe } from "bun:test";
import {
  importedMessageId,
  importedThreadId,
  threadCreate,
  threadHistoryImport,
  threadUnsettle,
} from "../src/t3/commands.ts";
import { claude } from "../src/providers/claude.ts";
import { codex } from "../src/providers/codex.ts";
import { latest } from "../src/time.ts";

describe("id conventions (AgentSessionImporter.ts:168,267)", () => {
  test("thread ids are deterministic and namespaced per provider", () => {
    expect(importedThreadId("347cd91a-749f-4f92-a41d-4b8e82e158d9", claude.id)).toBe(
      "import:claudeAgent:347cd91a-749f-4f92-a41d-4b8e82e158d9",
    );
    expect(importedThreadId("s", codex.id)).toBe("import:codex:s");
  });

  test("message ids are the thread id plus a 6-digit index", () => {
    expect(importedMessageId("import:claudeAgent:x", 0)).toBe("import:claudeAgent:x:000000");
    expect(importedMessageId("import:claudeAgent:x", 1462)).toBe("import:claudeAgent:x:001462");
  });
});

describe("threadCreate mirrors decider.ts thread.create", () => {
  const command = threadCreate({
    threadId: "import:claudeAgent:s",
    projectId: "p",
    title: "T",
    model: "claude-opus-5",
    providerId: claude.id,
    createdAt: "2026-09-01T00:00:00.000Z",
  });

  test("emits one thread.created tagged as a history import", () => {
    expect(command.events).toHaveLength(1);
    expect(command.events[0]!.type).toBe("thread.created");
    expect(command.events[0]!.metadata).toEqual({ historyImport: true });
  });

  test("payload keys match what T3 writes", () => {
    expect(Object.keys(command.events[0]!.payload as object).sort()).toEqual([
      "branch",
      "createdAt",
      "interactionMode",
      "modelSelection",
      "projectId",
      "runtimeMode",
      "threadId",
      "title",
      "updatedAt",
      "worktreePath",
    ]);
  });
});

describe("threadHistoryImport mirrors decider.ts:2003", () => {
  const messages = [
    { role: "user" as const, text: "a", createdAt: "2026-09-01T00:00:00.000Z" },
    { role: "assistant" as const, text: "b", createdAt: "2026-09-03T00:00:00.000Z" },
    { role: "user" as const, text: "c", createdAt: "2026-09-02T00:00:00.000Z" },
  ];
  const command = threadHistoryImport("import:claudeAgent:s", messages);

  test("one message-sent per message, then a single settled", () => {
    expect(command.events.map((e) => e.type)).toEqual([
      "thread.message-sent",
      "thread.message-sent",
      "thread.message-sent",
      "thread.settled",
    ]);
  });

  test("settles at the newest message, not the last one", () => {
    expect((command.events.at(-1)!.payload as { settledAt: string }).settledAt).toBe(
      "2026-09-03T00:00:00.000Z",
    );
  });

  test("messages carry no turn and are not streaming", () => {
    const first = command.events[0]!.payload as { turnId: null; streaming: boolean };
    expect(first.turnId).toBeNull();
    expect(first.streaming).toBe(false);
  });

  test("attachments and context are omitted, as history imports do", () => {
    const keys = Object.keys(command.events[0]!.payload as object);
    expect(keys).not.toContain("attachments");
    expect(keys).not.toContain("context");
  });

  test("an empty history is rejected, matching the decider's invariant", () => {
    expect(() => threadHistoryImport("t", [])).toThrow(/at least one message/);
  });
});

test("latest compares ISO timestamps lexically", () => {
  expect(latest(["2026-01-02T00:00:00.000Z", "2026-01-10T00:00:00.000Z"], "2026-01-01T00:00:00.000Z")).toBe(
    "2026-01-10T00:00:00.000Z",
  );
});

describe("imported threads are brought into the active list", () => {
  const command = threadUnsettle("import:claudeAgent:s", "2026-09-01T00:00:00.000Z");

  test("one thread.unsettled, the way decider.ts thread.unsettle writes it", () => {
    expect(command.events.map((e) => e.type)).toEqual(["thread.unsettled"]);
  });

  test('reason is "user", which pins it active instead of only clearing the timestamp', () => {
    // ProjectionPipeline.ts:697 — "activity" leaves settledOverride null and auto-settle
    // can put the thread straight back.
    expect(command.events[0]!.payload).toEqual({
      threadId: "import:claudeAgent:s",
      reason: "user",
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
  });
});
