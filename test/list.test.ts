import { expect, test, describe } from "bun:test";
import { matches } from "../src/cli/filter.ts";
import { parseSort, sortRows } from "../src/cli/sort.ts";
import type { Listed } from "../src/cli/report.ts";
import type { Session } from "../src/session.ts";
import { abbreviate, abbreviationWidth } from "../src/cli/abbrev.ts";

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

  test("grows past a shared prefix (Codex's time-ordered v7 ids)", () => {
    // Both start 01a0e776: the first 48 bits of a UUIDv7 are a millisecond timestamp.
    const width = abbreviationWidth([
      "01a0e776-e594-7722-86ec-c75d00d64a29",
      "01a0e776-ab49-76a3-a96d-da1c67ca38ef",
    ]);
    expect(width).toBeGreaterThan(8);
    expect("01a0e776-e594-7722-86ec-c75d00d64a29".slice(0, width)).not.toBe(
      "01a0e776-ab49-76a3-a96d-da1c67ca38ef".slice(0, width),
    );
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
});
