import { expect, test, describe } from "bun:test";
import { parse } from "../src/cli/args.ts";
import { PROVIDERS } from "../src/providers/index.ts";

describe("argument parsing", () => {
  test("command and refs are positionals", () => {
    const args = parse(["import", "347cd91a", "48c22e85"]);
    expect(args.command).toBe("import");
    expect(args.refs).toEqual(["347cd91a", "48c22e85"]);
  });

  test("--project takes a value", () => {
    expect(parse(["import", "--project", "~/repo"]).flags.project).toBe("~/repo");
    expect(parse(["import", "--project=~/repo"]).flags.project).toBe("~/repo");
  });

  test("no provider flag means every provider", () => {
    expect(parse(["list"]).providers).toEqual(PROVIDERS);
  });

  test("a provider flag narrows the selection", () => {
    expect(parse(["list", "--codex"]).providers.map((p) => p.label)).toEqual(["codex"]);
    expect(parse(["list", "--claude", "--codex"]).providers).toHaveLength(2);
  });

  test("an unknown flag is rejected rather than ignored", () => {
    expect(() => parse(["import", "--projekt", "x"])).toThrow();
  });

  test("-h is help", () => {
    expect(parse(["-h"]).flags.help).toBe(true);
  });
});

test("--all is gone; bare import means every importable session", () => {
  expect(() => parse(["import", "--all"])).toThrow(/Unknown option/);
  expect(parse(["import"]).refs).toEqual([]);
});

test("undo takes an optional run reference", () => {
  expect(parse(["undo"]).refs).toEqual([]);
  expect(parse(["undo", "d03f8e72"]).refs).toEqual(["d03f8e72"]);
});
