/** T3 stores timestamps as ISO-8601 UTC with milliseconds, e.g. 2026-09-28T10:26:27.634Z. */
export const nowIso = (): string => new Date().toISOString();

export const isoFromMs = (ms: number): string => new Date(ms).toISOString();

export function isoOr(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString();
}

/** Latest of a set of ISO timestamps; string comparison is valid for this format. */
export function latest(values: readonly string[], fallback: string): string {
  return values.reduce((max, v) => (v > max ? v : max), fallback);
}
