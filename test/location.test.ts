import { expect, test, describe } from "bun:test";
import { describeLocation, formatLocation } from "../src/cli/location.ts";

const ROOT = "/Users/x/space/arch";
const shown = (cwd: string | null, root: string | null = ROOT, width?: number) =>
  formatLocation(describeLocation(cwd, root), width);

describe("where a session ran", () => {
  test("the checkout itself", () => {
    expect(shown(ROOT)).toBe("/arch/(parent)");
  });

  test("a managed worktree names the tool that made it", () => {
    expect(shown("/Users/x/.superset/worktrees/arch/few-column")).toBe("superset/arch/few-column");
    expect(shown("/Users/x/.t3/worktrees/arch/t3code-e204")).toBe("t3/arch/t3code-e204");
  });

  test("a worktree beside the repository is Claude's", () => {
    expect(shown("/Users/x/space/arch.worktrees/agent-a01")).toBe("claude/arch/agent-a01");
  });

  test("a directory inside the checkout names the part below it", () => {
    expect(shown("/Users/x/space/arch/packages/api")).toBe("/arch/packages/api");
  });

  test("no working directory at all", () => {
    expect(shown(null)).toBe("NA");
  });

  test("a worktree of an unrelated repository is still described", () => {
    expect(shown("/Users/x/.superset/worktrees/other/thing", ROOT)).toBe("superset/other/thing");
  });
});

describe("fitting a column", () => {
  const long = "/Users/x/.superset/worktrees/arch/monitoring-reap-and-rain-warnings-channel";

  test("the tool and repository survive; the worktree name is shortened", () => {
    const out = shown(long, ROOT, 34);
    expect(out).toHaveLength(34);
    expect(out.startsWith("superset/arch/")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  test("what fits is left alone", () => {
    expect(shown("/Users/x/.t3/worktrees/arch/t3code-e204", ROOT, 34)).toBe("t3/arch/t3code-e204");
  });

  test("a width too small for even the prefix still fits the column", () => {
    expect(shown(long, ROOT, 8)).toHaveLength(8);
  });
});
