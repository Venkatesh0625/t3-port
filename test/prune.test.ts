import { expect, test, describe } from "bun:test";
import { findRedundant } from "../src/ops/prune.ts";
import type { Session } from "../src/session.ts";

const HOME = "/Users/x";
const PROJECTS = `${HOME}/.claude/projects`;
const config = { claudeProjects: PROJECTS } as never;

/** A database whose only answer is which directories a thread resumes from. */
const dbWith = (cwds: readonly string[]) =>
  ({
    query: () => ({
      all: () => cwds.map((cwd) => ({ runtime_payload_json: JSON.stringify({ cwd }) })),
    }),
  }) as never;

const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
const copy = (cwd: string, id: string) => `${PROJECTS}/${slug(cwd)}/${id}.jsonl`;

const session = (id: string, cwd: string): Session =>
  ({ provider: "claudeAgent", sessionId: id, cwd, path: copy(cwd, id) }) as Session;

const REPO = `${HOME}/code/app`;
const DEAD = `${HOME}/.superset/worktrees/app/gone-leaf`;
const ID = "347cd91a";

// The worktree is gone; its transcript was also copied to the project root.
const COPIES = [copy(DEAD, ID), copy(REPO, ID)];
const exists = (dir: string) => dir === REPO;
const size = (path: string) => (path.includes(slug(DEAD)) ? 100 : 200);

describe("which transcript copies can be removed", () => {
  test("a copy in a directory that no longer exists", () => {
    const found = findRedundant(dbWith([]), config, [session(ID, DEAD)], () => COPIES, exists, size);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe(copy(DEAD, ID));
    expect(found[0]!.keeping).toBe(copy(REPO, ID));
  });

  test("never the last copy: with one on disk there is nothing redundant", () => {
    const found = findRedundant(dbWith([]), config, [session(ID, DEAD)], () => [copy(DEAD, ID)], exists, size);
    expect(found).toEqual([]);
  });

  test("never a directory a thread resumes from", () => {
    // T3 runs the thread in the dead worktree's directory, so its transcript has to stay.
    const found = findRedundant(dbWith([DEAD]), config, [session(ID, DEAD)], () => COPIES, exists, size);
    expect(found).toEqual([]);
  });

  test("never a copy whose directory still exists", () => {
    const found = findRedundant(dbWith([]), config, [session(ID, REPO)], () => COPIES, () => true, size);
    expect(found).toEqual([]);
  });

  test("a directory we cannot place is left alone", () => {
    // No session records this cwd, so nothing proves the directory is gone.
    const other = `${PROJECTS}/-Users-x-somewhere-else/${ID}.jsonl`;
    const found = findRedundant(dbWith([]), config, [session(ID, REPO)], () => [other, copy(REPO, ID)], exists, size);
    expect(found).toEqual([]);
  });

  test("Codex rollouts are not touched: they are addressed by id, not by directory", () => {
    const codex = { ...session(ID, DEAD), provider: "codex" } as Session;
    expect(findRedundant(dbWith([]), config, [codex], () => COPIES, exists, size)).toEqual([]);
  });
});
