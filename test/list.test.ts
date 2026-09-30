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
    row({ id: "01a0e776", title: "preview-cleanup", project: "/Users/x/code/web-app" }),
    row({ id: "019f7b0c", title: "Building many small apps", project: "/Users/x/code/api" }),
    row({ id: "abc12345", title: "Deploy API", cwd: "/tmp/scratch" }),
  ];
  const hits = (...terms: string[]) =>
    rows.filter((r) => matches(r, "codex", terms)).map((r) => r.session.sessionId);

  test("no terms keeps everything", () => {
    expect(hits()).toHaveLength(3);
  });

  test("matches a title word", () => {
    expect(hits("preview")).toEqual(["01a0e776"]);
  });

  test("matches a session id prefix", () => {
    expect(hits("019f")).toEqual(["019f7b0c"]);
  });

  test("matches a project name", () => {
    expect(hits("web-app")).toEqual(["01a0e776"]);
  });

  test("matches the working directory when there is no project", () => {
    expect(hits("scratch")).toEqual(["abc12345"]);
  });

  test("matches the agent", () => {
    expect(hits("codex")).toHaveLength(3);
  });

  test("is case-insensitive", () => {
    expect(hits("PREVIEW")).toEqual(["01a0e776"]);
  });

  test("terms narrow rather than widen", () => {
    expect(hits("codex", "web-app")).toEqual(["01a0e776"]);
    expect(hits("web-app", "preview")).toEqual(["01a0e776"]);
    expect(hits("web-app", "nothing")).toEqual([]);
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
  // Most cases measure a listing against itself; the regression below is the one that doesn't.
  const width = (ids: string[]) => abbreviationWidth(ids, ids);

  test("eight characters when that is enough (Claude's random v4 ids)", () => {
    expect(width(["347cd91a-749f-4f92-a41d-4b8e82e158d9", "f023f049-9a13-48d0-af47-520acf1c46a1"])).toBe(8);
  });

  test("grows past a shared prefix, to the next whole group", () => {
    // Both start 01a0e776: the first 48 bits of a UUIDv7 are a millisecond timestamp.
    const ids = ["01a0e776-e594-7722-86ec-c75d00d64a29", "01a0e776-ab49-76a3-a96d-da1c67ca38ef"];
    const w = width(ids);
    expect(w).toBe(13);
    expect(ids.map((id) => id.slice(0, w))).toEqual(["01a0e776-e594", "01a0e776-ab49"]);
  });

  test("a truncated group is never shown", () => {
    const w = width([
      "01a0e776-e594-7722-86ec-c75d00d64a29",
      "01a0e776-ab49-76a3-a96d-da1c67ca38ef",
      "01a0e776-ac00-7000-8000-000000000000",
    ]);
    expect([8, 13, 18, 23, 36]).toContain(w);
  });

  test("ids that are not UUIDs still grow one character at a time", () => {
    expect(width(["import-aaa", "import-aab"])).toBe(10);
  });

  test("one width is used for the whole listing, so the column stays aligned", () => {
    const ids = [
      "01a0e776-e594-7722-86ec-c75d00d64a29",
      "01a0e776-ab49-76a3-a96d-da1c67ca38ef",
      "347cd91a-749f-4f92-a41d-4b8e82e158d9",
    ];
    const { width: w, of } = abbreviate(ids, ids);
    expect(of("347cd91a-749f-4f92-a41d-4b8e82e158d9")).toHaveLength(w);
  });

  test("an empty listing needs no width", () => {
    expect(width([])).toBe(8);
  });
});

describe("an abbreviation is unique among every session, not the ones shown", () => {
  // A checkout's only Codex session was listed as 01a0e207, and `import 01a0e207` then refused:
  // another rollout elsewhere on disk started the same way.
  const here = "01a0e207-9cba-7af3-89d2-5f376c15070c";
  const elsewhere = "01a0e207-7034-77f3-bade-083ca2975325";

  test("a session outside the listing still widens the id", () => {
    const { of } = abbreviate([here], [here, elsewhere]);
    expect(of(here)).toBe("01a0e207-9cba");
    expect(elsewhere.startsWith(of(here))).toBe(false);
  });

  test("sessions that share nothing with the listing cost nothing", () => {
    expect(abbreviationWidth([here], [here, "f023f049-9a13-48d0-af47-520acf1c46a1"])).toBe(8);
  });

  test("the same id twice is one session, not a collision", () => {
    // Claude keeps copies of a transcript under several project directories; resolving
    // treats them as one session, so they must not force the full id.
    const id = "70abaae3-6bac-4834-abed-04720e8ba949";
    expect(abbreviationWidth([id, id], [id, id])).toBe(8);
  });

  test("an id that prefixes another is shown whole", () => {
    expect(abbreviationWidth(["import-aa"], ["import-aa", "import-aab"])).toBe(9);
  });
});

describe("noise is dropped from a scan, never from a named session", () => {
  const hi = session({
    sessionId: "347cd91a-749f-4f92-a41d-4b8e82e158d9",
    provider: "claudeAgent",
    cwd: "/repo",
    turns: [
      { role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", text: "Hello!", createdAt: "2026-01-01T00:00:01.000Z" },
    ],
  });
  const reasonFor = (named: boolean) =>
    plan(
      { query: () => ({ all: () => [], get: () => undefined }) } as never,
      [hi],
      { named, now: 0 },
      "/worktrees",
    ).skipped[0]?.reason;

  test("a scan skips it", () => {
    expect(reasonFor(false)).toBe("noise");
  });

  test("naming it is enough to import it — there is no flag to add", () => {
    expect(reasonFor(true)).not.toBe("noise");
  });
});

describe("sessions that are still running", () => {
  const NOW = 1_800_000_000_000;

  const fresh = (mtimeMs: number): Session =>
    session({
      sessionId: "347cd91a-749f-4f92-a41d-4b8e82e158d9",
      provider: "claudeAgent",
      cwd: "/repo",
      // Long enough not to read as a command record, which is checked before liveness.
      turns: [
        { role: "user", text: "walk me through the retry logic in the worker", createdAt: "2026-01-01T00:00:00.000Z" },
        {
          role: "assistant",
          text: "it retries three times with exponential backoff, then parks the job on the dead-letter queue",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        { role: "user", text: "and what happens after that", createdAt: "2026-01-01T00:00:02.000Z" },
      ],
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
