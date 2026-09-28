import { basename } from "node:path";
import { readFileSync } from "node:fs";

/**
 * Process checks via `ps`, which exists on macOS and Linux alike.
 *
 * Reading /proc/<pid>/cmdline — the obvious Linux approach — silently reports "nothing
 * running" on macOS, where /proc does not exist. A guard that fails open is worse than
 * no guard, since the whole point is refusing to write under a live T3 Code.
 */

function ps(args: string[]): string | null {
  try {
    const run = Bun.spawnSync(["ps", ...args], { stdout: "pipe", stderr: "ignore" });
    return run.success ? run.stdout.toString() : null;
  } catch {
    return null;
  }
}

export function commandOf(pid: number): string | null {
  const line = ps(["-p", String(pid), "-o", "args="])?.trim();
  return line || null;
}

export function processList(): Array<{ pid: number; command: string }> {
  const out = ps(["-axo", "pid=,args="]);
  if (!out) return [];
  const found: Array<{ pid: number; command: string }> = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid) found.push({ pid, command: m[2] ?? "" });
  }
  return found;
}

/** The live T3 Code server, if any. Its binary is "t3" on Linux and "T3 Code" on macOS. */
export function liveServer(runtimeFile: string, inspect = commandOf): { pid: number; command: string } | null {
  let pid: unknown;
  try {
    pid = JSON.parse(readFileSync(runtimeFile, "utf8")).pid;
  } catch {
    return null;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
  const command = inspect(pid);
  return command && command.toLowerCase().includes("t3") ? { pid, command } : null;
}

/** A `claude` process holding a session open, so we never rewrite its transcript underneath it. */
export function claudeHolding(sessionId: string, list = processList): number | null {
  for (const { pid, command } of list()) {
    const args = command.split(/\s+/).filter(Boolean);
    if (!args.slice(0, 2).some((a) => basename(a) === "claude")) continue;
    if (args.some((a) => a.endsWith(sessionId))) return pid;
  }
  return null;
}
