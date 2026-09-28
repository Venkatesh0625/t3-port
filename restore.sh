#!/usr/bin/env bash
# Restore a T3 Code state.sqlite backup. Run with T3 Code QUIT.
set -euo pipefail

BACKUP="${1:-}"
DIR="$HOME/.t3/userdata"
DB="$DIR/state.sqlite"

[ -n "$BACKUP" ] || { echo "usage: ./restore.sh <backup.bak>"; exit 2; }
[ -f "$BACKUP" ] || { echo "no such backup: $BACKUP"; exit 1; }

if pgrep -f "T3 Code" >/dev/null 2>&1; then
  echo "T3 Code is still running. Quit it (Cmd+Q) and re-run."
  exit 1
fi

echo "Checking the backup..."
[ "$(sqlite3 -readonly "$BACKUP" 'pragma integrity_check;')" = "ok" ] || { echo "backup failed integrity check"; exit 1; }
sqlite3 -readonly "$BACKUP" "select 'threads: ' || count(*) from projection_threads where deleted_at is null;"

STAMP=$(date +%Y%m%d-%H%M%S)
echo "Setting the current database aside as *.before-restore-$STAMP ..."
for f in state.sqlite state.sqlite-wal state.sqlite-shm; do
  [ -e "$DIR/$f" ] && mv "$DIR/$f" "$DIR/$f.before-restore-$STAMP"
done
# The -wal must not survive: SQLite would replay it over the restored file.

echo "Restoring..."
cp "$BACKUP" "$DB"

echo "Verifying..."
sqlite3 -readonly "$DB" "pragma integrity_check;"
echo "import events remaining: $(sqlite3 -readonly "$DB" "select count(*) from orchestration_events where stream_id like 'import:%';")"

echo
echo "Done. Reopen T3 Code:  open -a 'T3 Code (Nightly)'"
echo "If anything looks wrong, the previous database is at:"
echo "  $DIR/state.sqlite.before-restore-$STAMP"
