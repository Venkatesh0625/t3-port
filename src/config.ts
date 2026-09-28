import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  readonly claudeProjects: string;
  readonly db: string;
  readonly runtimeFile: string;
  readonly worktrees: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): Config {
  const claudeHome = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const t3Home = env.T3CODE_HOME ?? join(home, ".t3");
  return {
    claudeProjects: join(claudeHome, "projects"),
    db: join(t3Home, "userdata", "state.sqlite"),
    runtimeFile: join(t3Home, "userdata", "server-runtime.json"),
    worktrees: join(t3Home, "worktrees"),
  };
}

export class PortError extends Error {
  static is(e: unknown): e is PortError {
    return e instanceof PortError;
  }
}
