import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Read a JSONL transcript a line at a time.
 *
 * Transcripts are mostly tool traffic: of a 38 MB Claude session, 0.25 MB is the prose that
 * becomes a thread — 0.7%. Reading the file into a string to split it therefore cost two
 * hundred times what the result needed, and forced a size limit that skipped exactly the
 * longest conversations. Streaming bounds the cost at one line, the largest of which is under
 * a megabyte even in that file.
 */
export async function* records(path: string): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a torn final line while the agent is still writing
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        yield parsed as Record<string, unknown>;
      }
    }
  } finally {
    lines.close();
  }
}
