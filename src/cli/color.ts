/**
 * ANSI colour, off unless the destination is a terminal.
 *
 * Honours NO_COLOR (https://no-color.org) and FORCE_COLOR, and stays off when output is piped so
 * escape codes never reach a grep or a file.
 */
const enabled =
  process.env.NO_COLOR === undefined &&
  (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY === true);

const wrap =
  (code: string) =>
  (text: string): string =>
    enabled ? `\u001b[${code}m${text}\u001b[0m` : text;

export const color = {
  enabled,
  dim: wrap("2"),
  bold: wrap("1"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
};

/** Pad to a visible width, ignoring any escape codes the text already carries. */
export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  const visible = text.replace(/\u001b\[[0-9;]*m/g, "").length;
  const fill = " ".repeat(Math.max(0, width - visible));
  return align === "left" ? text + fill : fill + text;
}
