import { expect, test, describe } from "bun:test";
import { homedir } from "node:os";
import { ellipsize, shortPath, tildify } from "../src/cli/paths.ts";
import { pad } from "../src/cli/color.ts";

describe("paths in the project column", () => {
  test("home becomes ~", () => {
    expect(tildify(`${homedir()}/personal/app`)).toBe("~/personal/app");
    expect(tildify("/var/tmp/x")).toBe("/var/tmp/x");
  });

  test("shortening keeps the tail, which is the part that identifies a directory", () => {
    expect(ellipsize("/a/very/long/path/to/somewhere", 12)).toBe("…o/somewhere");
    expect(ellipsize("/short", 12)).toBe("/short");
  });

  test("shortPath does both", () => {
    expect(shortPath(`${homedir()}/x`, 40)).toBe("~/x");
  });
});

describe("column padding", () => {
  test("pads to a visible width, ignoring escape codes", () => {
    expect(pad("abc", 6)).toBe("abc   ");
    expect(pad("\u001b[32mabc\u001b[0m", 6)).toBe("\u001b[32mabc\u001b[0m   ");
    expect(pad("abc", 6, "right")).toBe("   abc");
  });

  test("never truncates when the text is already wider", () => {
    expect(pad("abcdefgh", 3)).toBe("abcdefgh");
  });
});
