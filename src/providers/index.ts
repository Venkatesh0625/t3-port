import { PortError } from "../errors.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import type { Provider } from "./types.ts";

export type { Provider, ReadOptions } from "./types.ts";

export const PROVIDERS: readonly Provider[] = [claude, codex];

export function byId(id: string): Provider {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new PortError(`unknown provider '${id}'`);
  return found;
}

export function byLabel(label: string): Provider | undefined {
  return PROVIDERS.find((p) => p.label === label);
}
