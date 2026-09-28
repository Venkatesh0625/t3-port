import { loadConfig } from "../config.ts";
import type { Args } from "../cli/args.ts";
import { collectAll } from "../cli/sessions.ts";
import { sessionLine } from "../cli/report.ts";
import { open } from "../t3/open.ts";
import { importedSessionIds, nativeSessionIds } from "../t3/queries.ts";

const LIMIT = 40;

export async function list(args: Args): Promise<number> {
  const config = loadConfig();
  const { db } = open(config, { write: false });
  const sessions = await collectAll(config, args.providers, {});

  const known = new Map(
    args.providers.map((p) => [
      p.id,
      { native: nativeSessionIds(db, p), imported: importedSessionIds(db, p) },
    ]),
  );

  console.log(`${sessions.length} session(s)\n`);
  for (const session of sessions.slice(0, LIMIT)) {
    const k = known.get(session.provider);
    const mark = k?.native.has(session.sessionId)
      ? "t3"
      : k?.imported.has(session.sessionId)
        ? "imported"
        : "-";
    console.log(sessionLine(session, mark));
  }
  if (sessions.length > LIMIT) console.log(`\n... ${sessions.length - LIMIT} more`);

  db.close();
  return 0;
}
