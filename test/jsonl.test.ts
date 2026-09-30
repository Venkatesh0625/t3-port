import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { records } from "../src/jsonl.ts";

const write = (lines: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "t3p-")), "t.jsonl");
  writeFileSync(path, lines);
  return path;
};

const read = async (lines: string) => {
  const out = [];
  for await (const r of records(write(lines))) out.push(r);
  return out;
};

describe("streaming a transcript", () => {
  test("yields one object per line", async () => {
    expect(await read('{"a":1}\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("skips blank lines", async () => {
    expect(await read('\n{"a":1}\n\n\n')).toEqual([{ a: 1 }]);
  });

  test("skips a torn final line, which is what a running agent leaves", async () => {
    expect(await read('{"a":1}\n{"a":2,"b"')).toEqual([{ a: 1 }]);
  });

  test("skips lines that are not objects", async () => {
    expect(await read('[1,2]\n"text"\n{"a":1}\nnull\n')).toEqual([{ a: 1 }]);
  });

  test("a file without a trailing newline still yields its last line", async () => {
    expect(await read('{"a":1}\n{"a":2}')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("an empty file yields nothing", async () => {
    expect(await read("")).toEqual([]);
  });
});
