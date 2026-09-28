import { expect, test, describe } from "bun:test";
import { matches } from "../src/cli/filter.ts";
import { parseSort, sortRows } from "../src/cli/sort.ts";
import type { Listed } from "../src/cli/report.ts";
import type { Session } from "../src/session.ts";
import { abbreviate, abbreviationWidth } from "../src/cli/abbrev.ts";
import { LIVE_WINDOW_MS, plan } from "../src/ops/import.ts";

const session = (over: Partial<Session> & { sessionId: string }): Session => ({
  provider: "codex",
  path: `/x/${over.sessionId}.jsonl`,
  title: "",
  model: null,
  cwd: null,
  turns: [],
  stat: { size: 0, mtimeMs: 0, dev: 0, ino: 0 },
  generated: 0,
  ...over,
});

const row = (over: {
  id: string;
  title?: string;
  project?: string | null;
  cwd?: string | null;
  turns?: number;
  mtime?: number;
  provider?: Session["provider"];
  mark?: string;
}): Listed => ({
  session: session({
    sessionId: over.id,
    title: over.title ?? "",
    cwd: over.cwd ?? null,
    provider: over.provider ?? "codex",
    turns: Array.from({ length: over.turns ?? 0 }, () => ({
      role: "user" as const,
      text: "x",
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
    stat: { size: 0, mtimeMs: over.mtime ?? 0, dev: 0, ino: 0 },
  }),
  mark: over.mark ?? "-",
  project: over.project ?? null,
});

describe("filtering", () => {
  const rows = [
    row({ id: "01a0e776", title: "cloudflare-bot-traffic-alert", project: "/Users/x/personal/xito-mono" }),
    row({ id: "019f7b0c", title: "Building many small apps", project: "/Users/x/personal/sa-engine" }),
    row({ id: "abc12345", title: "Deploy API", cwd: "/tmp/scratch" }),
  ];
  const hits = (...terms: string[]) =>
    rows.filter((r) => matches(r, "codex", terms)).map((r) => r.session.sessionId);

  test("no terms keeps everything", () => {
    expect(hits()).toHaveLength(3);
  });

  test("matches a title word", () => {
    expect(hits("cloudflare")).toEqual(["01a0e776"]);
  });

  test("matches a session id prefix", () => {
    expect(hits("019f")).toEqual(["019f7b0c"]);
  });

  test("matches a project name", () => {
    expect(hits("xito")).toEqual(["01a0e776"]);
  });

  test("matches the working directory when there is no project", () => {
    expect(hits("scratch")).toEqual(["abc12345"]);
  });

  test("matches the agent", () => {
    expect(hits("codex")).toHaveLength(3);
  });

  test("is case-insensitive", () => {
    expect(hits("CLOUDFLARE")).toEqual(["01a0e776"]);
  });

  test("terms narrow rather than widen", () => {
    expect(hits("codex", "xito")).toEqual(["01a0e776"]);
    expect(hits("xito", "cloudflare")).toEqual(["01a0e776"]);
    expect(hits("xito", "nothing")).toEqual([]);
  });
});

describe("sorting", () => {
  const label = () => "codex";
  const rows = [
    row({ id: "a", project: "/p/beta", turns: 5, mtime: 300 }),
    row({ id: "b", project: "/p/alpha", turns: 2, mtime: 200 }),
    row({ id: "c", project: "/p/alpha", turns: 90, mtime: 100 }),
    row({ id: "d", project: null, cwd: "/tmp", turns: 50, mtime: 400 }),
  ];
  const order = (sort: Parameters<typeof sortRows>[1]) =>
    sortRows(rows, sort, label).map((r) => r.session.sessionId);

  test("recent is the default ordering", () => {
    expect(parseSort(undefined)).toBe("recent");
    expect(order("recent")).toEqual(["d", "a", "b", "c"]);
  });

  test("project groups, and within a group the largest comes first", () => {
    expect(order("project")).toEqual(["c", "b", "a", "d"]);
  });

  test("sessions with no project sort last", () => {
    expect(order("project").at(-1)).toBe("d");
  });

  test("turns ignores grouping", () => {
    expect(order("turns")).toEqual(["c", "d", "a", "b"]);
  });

  test("an unknown sort is rejected", () => {
    expect(() => parseSort("sideways")).toThrow(/--sort takes one of/);
  });
});

describe("session id abbreviation", () => {
  test("eight characters when that is enough (Claude's random v4 ids)", () => {
    expect(
      abbreviationWidth(["347cd91a-749f-4f92-a41d-4b8e82e158d9", "f023f049-9a13-48d0-af47-520acf1c46a1"]),
    ).toBe(8);
  });

  test("grows past a shared prefix, to the next whole group", () => {
    // Both start 01a0e776: the first 48 bits of a UUIDv7 are a millisecond timestamp.
    const ids = ["01a0e776-e594-7722-86ec-c75d00d64a29", "01a0e776-ab49-76a3-a96d-da1c67ca38ef"];
    const width = abbreviationWidth(ids);
    expect(width).toBe(13);
    expect(ids.map((id) => id.slice(0, width))).toEqual(["01a0e776-e594", "01a0e776-ab49"]);
  });

  test("a truncated group is never shown", () => {
    const width = abbreviationWidth([
      "01a0e776-e594-7722-86ec-c75d00d64a29",
      "01a0e776-ab49-76a3-a96d-da1c67ca38ef",
      "01a0e776-ac00-7000-8000-000000000000",
    ]);
    expect([8, 13, 18, 23, 36]).toContain(width);
  });

  test("ids that are not UUIDs still grow one character at a time", () => {
    expect(abbreviationWidth(["import-aaa", "import-aab"])).toBe(10);
  });

  test("one width is used for the whole listing, so the column stays aligned", () => {
    const { width, of } = abbreviate([
      "01a0e776-e594-7722-86ec-c75d00d64a29",
      "01a0e776-ab49-76a3-a96d-da1c67ca38ef",
      "347cd91a-749f-4f92-a41d-4b8e82e158d9",
    ]);
    expect(of("347cd91a-749f-4f92-a41d-4b8e82e158d9")).toHaveLength(width);
  });

  test("identical ids cannot be split, so it stops at full length", () => {
    expect(abbreviationWidth(["aaaaaaaaaa", "aaaaaaaaaa"])).toBe(10);
  });

  test("an empty listing needs no width", () => {
    expect(abbreviationWidth([])).toBe(8);
  });
});

describe("abbreviation is not derailed by duplicates", () => {
  test("a repeated id cannot be split, so the width does not blow up for the rest", () => {
    // Listings deduplicate before this point; the guard keeps a stray duplicate from
    // forcing every id in the column to its full length.
    const width = abbreviationWidth([
      "70abaae3-6bac-4834-abed-04720e8ba949",
      "70abaae3-6bac-4834-abed-04720e8ba949",
    ]);
    expect(width).toBe(36);
  });
});

describe("sessions that are still running", () => {
  const NOW = 1_800_000_000_000;

  const fresh = (mtimeMs: number): Session =>
    session({
      sessionId: "347cd91a-749f-4f92-a41d-4b8e82e158d9",
      provider: "claudeAgent",
      cwd: "/repo",
      turns: [{ role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" }],
      stat: { size: 1, mtimeMs, dev: 0, ino: 0 },
    });

  const reasonFor = (mtimeMs: number, includeLive = false) =>
    plan(
      { query: () => ({ all: () => [], get: () => undefined }) } as never,
      [fresh(mtimeMs)],
      { includeLive, now: NOW },
      "/worktrees",
    ).skipped[0]?.reason;

  test("a transcript written seconds ago is held back", () => {
    expect(reasonFor(NOW - 5_000)).toBe("in-progress");
  });

  test("one untouched for longer than the window is not", () => {
    expect(reasonFor(NOW - LIVE_WINDOW_MS - 1)).not.toBe("in-progress");
  });

  test("--include-live overrides it", () => {
    expect(reasonFor(NOW - 5_000, true)).not.toBe("in-progress");
  });
});
