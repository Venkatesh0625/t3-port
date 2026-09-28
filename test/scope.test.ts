import { expect, test, describe } from "bun:test";
import { makeScope, pathSuggestsScope } from "../src/scope.ts";

/**
 * inScope consults git for directories that exist, so these cover the decisions reachable from
 * a path alone — which is every decision for a worktree, and the ones that matter for `~`.
 */
describe("what a path alone can decide", () => {
  const home = makeScope("/Users/x");
  const repo = makeScope("/Users/x/code/app");

  test("the scope directory itself is in scope", () => {
    expect(pathSuggestsScope("/Users/x", home)).toBe(true);
    expect(pathSuggestsScope("/Users/x/code/app", repo)).toBe(true);
  });

  test("a directory below the scope is undecidable without git", () => {
    // It could be a subdirectory of this checkout, or a checkout of its own.
    expect(pathSuggestsScope("/Users/x/code/app/src", repo)).toBeNull();
    expect(pathSuggestsScope("/Users/x/code/app", home)).toBeNull();
  });

  test("a directory outside the scope is out", () => {
    expect(pathSuggestsScope("/tmp/scratch", repo)).toBe(false);
    expect(pathSuggestsScope("/Users/y/code/app", home)).toBe(false);
  });

  describe("worktrees belong to their repository, wherever they are kept", () => {
    const cases = [
      ["/Users/x/.t3/worktrees/app/blue-heron", true],
      ["/Users/x/.superset/worktrees/app/cherry-henley", true],
      ["/Users/x/code/app.worktrees/agent-a01", true],
      ["/Users/x/.superset/worktrees/other/thing", false],
    ] as const;

    for (const [cwd, expected] of cases) {
      test(`${cwd} -> ${expected}`, () => {
        expect(pathSuggestsScope(cwd, repo)).toBe(expected);
      });
    }

    test("a worktree is not claimed by the home directory that contains it", () => {
      // The bug this rule exists for: --path ~ used to match everything beneath it.
      expect(pathSuggestsScope("/Users/x/.t3/worktrees/app/blue-heron", home)).toBe(false);
    });
  });
});
