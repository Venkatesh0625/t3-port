import { loadConfig } from "../config.ts";
import type { Args } from "../cli/args.ts";
import { collectAll } from "../cli/sessions.ts";
import { sessionHeader, sessionLine, type Listed } from "../cli/report.ts";
import { PortError } from "../errors.ts";
import { enclosing } from "../ops/locate.ts";
import { color } from "../cli/color.ts";
import { open } from "../t3/open.ts";
import { importedSessionIds, nativeSessionIds, projects } from "../t3/queries.ts";

/** A page that fits a terminal; piped output is never truncated. */
const TTY_LIMIT = 40;

function positiveInt(value: string | boolean | undefined, name: string, fallback: number): number {
  if (value === undefined || typeof value === "boolean") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new PortError(`--${name} takes a whole number`);
  return parsed;
}

export async function list(args: Args): Promise<number> {
  const config = loadConfig();
  const { db } = open(config, { write: false });

  const sessions = await collectAll(config, args.providers, {});
  const all = projects(db);
  const known = new Map(
    args.providers.map((p) => [p.id, { native: nativeSessionIds(db, p), imported: importedSessionIds(db, p) }]),
  );
  const label = new Map(args.providers.map((p) => [p.id, p.label]));

  const rows: Listed[] = sessions.map((session) => {
    const k = known.get(session.provider);
    return {
      session,
      mark: k?.native.has(session.sessionId) ? "t3" : k?.imported.has(session.sessionId) ? "imported" : "-",
      project: enclosing(all, session.cwd)?.workspaceRoot ?? null,
    };
  });
  db.close();

  // Only a terminal gets a page; a pipe gets everything, so `| grep` and `| wc` behave.
  const interactive = process.stdout.isTTY === true;
  const offset = positiveInt(args.flags.offset, "offset", 0);
  const limit = positiveInt(args.flags.limit, "limit", interactive ? TTY_LIMIT : 0);
  const page = limit === 0 ? rows.slice(offset) : rows.slice(offset, offset + limit);

  const shown = page.length === 0 ? "none" : `${offset + 1}–${offset + page.length}`;
  console.log(`${color.bold(String(rows.length))} session(s), showing ${shown}\n`);
  console.log(sessionHeader());
  for (const row of page) {
    console.log(sessionLine(row, (s) => label.get(s.provider) ?? s.provider));
  }

  const remaining = rows.length - (offset + page.length);
  if (remaining > 0) {
    console.log(color.dim(`\n${remaining} more — "--offset ${offset + page.length}", "--limit 0", or pipe to a pager.`));
  }
  return 0;
}
