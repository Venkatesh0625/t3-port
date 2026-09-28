import { loadConfig } from "../config.ts";
import { requireScope, type Args } from "../cli/args.ts";
import { collectAll } from "../cli/sessions.ts";
import { projectWidth, sessionHeader, sessionLine, type Listed } from "../cli/report.ts";
import { matches } from "../cli/filter.ts";
import { isNoise } from "../noise.ts";
import { abbreviate } from "../cli/abbrev.ts";
import { parseSort, sortRows } from "../cli/sort.ts";
import { PortError } from "../errors.ts";
import { enclosing } from "../ops/locate.ts";
import { color } from "../cli/color.ts";
import { tooLargeNote } from "../cli/report.ts";
import { shortPath } from "../cli/paths.ts";
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
  const scope = requireScope(args);
  const { db } = open(config, { write: false });

  const { sessions, skipped } = await collectAll(config, args.providers, {}, scope);
  const all = projects(db);
  const known = new Map(
    args.providers.map((p) => [p.id, { native: nativeSessionIds(db, p), imported: importedSessionIds(db, p) }]),
  );
  const label = new Map(args.providers.map((p) => [p.id, p.label]));

  const labelOf = (providerId: string): string => label.get(providerId) ?? providerId;
  const terms = args.refs;

  const rows: Listed[] = sessions.map((session) => {
    const k = known.get(session.provider);
    return {
      session,
      mark: k?.native.has(session.sessionId) ? "t3" : k?.imported.has(session.sessionId) ? "imported" : "-",
      project: enclosing(all, session.cwd)?.workspaceRoot ?? null,
    };
  });
  db.close();

  const showNoise = args.flags["include-noise"] === true;
  const signal = showNoise ? rows : rows.filter((row) => !isNoise(row.session));
  const hidden = rows.length - signal.length;

  const found = sortRows(
    signal.filter((row) => matches(row, labelOf(row.session.provider), terms)),
    parseSort(args.flags.sort),
    labelOf,
  );

  // Only a terminal gets a page; a pipe gets everything, so `| grep` and `| wc` behave.
  const interactive = process.stdout.isTTY === true;
  const offset = positiveInt(args.flags.offset, "offset", 0);
  const limit = positiveInt(args.flags.limit, "limit", interactive ? TTY_LIMIT : 0);
  const page = limit === 0 ? found.slice(offset) : found.slice(offset, offset + limit);

  const shown = page.length === 0 ? "none" : `${offset + 1}–${offset + page.length}`;
  const matching = terms.length > 0 ? ` matching ${terms.map((t) => `"${t}"`).join(" ")}` : "";
  const of = terms.length > 0 ? color.dim(` of ${rows.length}`) : "";
  console.log(
    `${color.bold(String(found.length))} session(s)${matching}${of} in ` +
      `${color.cyan(shortPath(scope.root, 48))}, showing ${shown}\n`,
  );
  // Width comes from every session, not the filtered ones: an id printed here is meant to be
  // handed back to `import`, which resolves against all of them. Narrowing the input would let
  // a filter print a prefix that is unique on screen and ambiguous everywhere else.
  const id = abbreviate(rows.map((r) => r.session.sessionId));
  const note = tooLargeNote(skipped);
  if (note) console.log(note);
  // Width comes from the page on show, so a column never pads for rows nobody sees.
  const width = projectWidth(page);
  console.log(sessionHeader(id.width, width));
  for (const row of page) console.log(sessionLine(row, (s) => labelOf(s.provider), id.of, width));

  if (hidden > 0) {
    console.log(color.dim(`\n${hidden} command and one-liner session(s) hidden — --include-noise to show.`));
  }

  const remaining = found.length - (offset + page.length);
  if (remaining > 0) {
    console.log(color.dim(`\n${remaining} more — "--offset ${offset + page.length}", "--limit 0", or pipe to a pager.`));
  }
  return 0;
}
