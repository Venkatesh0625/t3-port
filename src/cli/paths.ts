import { homedir } from "node:os";

const HOME = homedir();

/** `/Users/you/personal/app` -> `~/personal/app`. */
export function tildify(path: string): string {
  return path === HOME || path.startsWith(HOME + "/") ? `~${path.slice(HOME.length)}` : path;
}

/**
 * Shorten from the left, keeping the tail.
 *
 * The end of a path says what it is; the beginning says where the home directory lives, which
 * the reader already knows.
 */
export function ellipsize(path: string, width: number): string {
  return path.length <= width ? path : `…${path.slice(path.length - width + 1)}`;
}

export const shortPath = (path: string, width: number): string => ellipsize(tildify(path), width);
