#!/usr/bin/env bash
# End-to-end test against a throwaway copy of the live state. Writes nothing outside $SB.
set -uo pipefail

SB=/tmp/t3-port-e2e
CLI="bun run $(cd "$(dirname "$0")" && pwd)/src/main.ts"
PASS=0; FAIL=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 — expected $3, got $2"; fi; }
head2(){ printf '\n\033[1m%s\033[0m\n' "$1"; }
q()    { sqlite3 -readonly "$SB/t3/userdata/state.sqlite" "$1" 2>/dev/null; }

run() { env T3CODE_HOME="$SB/t3" CLAUDE_CONFIG_DIR="$SB/claude" CODEX_HOME="$SB/codex" $CLI "$@"; }
# list and import are scoped commands now; SCOPE is the checkout the fixture exercises.
SCOPE="$HOME/personal/xito-mono"
runs_in() { run "$@" --path "$SCOPE"; }

head2 "Building sandbox from live state"
rm -rf "$SB"; mkdir -p "$SB/t3/userdata" "$SB/claude" "$SB/codex"
# Start from a state with no import history, so counts mean what they say.
BASE=$(ls -t ~/.t3/userdata/state.sqlite.t3-port-*.bak 2>/dev/null | tail -1)
BASE=${BASE:-~/.t3/userdata/state.sqlite}
sqlite3 -readonly "$BASE" "VACUUM INTO '$SB/t3/userdata/state.sqlite'"
echo "  base: $(basename "$BASE")"
# Copied, not linked: import may write into the Claude home. -p keeps the original mtimes, or
# every fixture would look like a session still being written to.
cp -Rp ~/.claude/projects "$SB/claude/projects"
cp -Rp ~/.codex/sessions  "$SB/codex/sessions"
echo "  db $(q 'select count(*) from projection_threads where deleted_at is null') live threads,"\
     "$(find "$SB/claude/projects" -name '*.jsonl' | wc -l | tr -d ' ') claude,"\
     "$(find "$SB/codex/sessions" -name '*.jsonl' | wc -l | tr -d ' ') codex transcripts"

head2 "doctor"
run doctor >/dev/null 2>&1; check "exits 0 on a matching schema" "$?" "0"

head2 "list"
# Distinct session ids, not files: depth 2 only (deeper files are subagent sidechains), and a
# transcript can sit in two directories when Claude copies a worktree session to the root.
CLAUDE_N=$(find "$SB/claude/projects" -mindepth 2 -maxdepth 2 -name '*.jsonl' -exec basename {} .jsonl \; | sort -u | wc -l | tr -d ' ')
CODEX_N=$(runs_in list --codex --include-noise 2>/dev/null | grep -m1 'session(s) in' | cut -d' ' -f1)
# Piped output is never truncated, so a count here is the real total.
check "--path is required"        "$(run list 2>&1 | grep -c 'path <dir> is required')" "1"
check "a scope narrows the listing" "$([ "$(runs_in list 2>/dev/null | grep -m1 'session(s) in' | cut -d' ' -f1)" -lt "$CLAUDE_N" ] && echo yes)" "yes"
check "both providers appear"     "$(runs_in list 2>/dev/null | grep -cE ' (claude|codex) ' | awk '{print ($1>0)?1:0}')" "1"
check "--limit caps the page"     "$(runs_in list --codex --include-noise --limit 7 2>/dev/null | grep -c ' codex ')" "7"
check "--offset skips"            "$(runs_in list --codex --include-noise --limit 2 --offset 1 2>/dev/null | grep -c 'showing 2')" "1"
check "--limit 0 means all"       "$(runs_in list --codex --include-noise --limit 0 2>/dev/null | grep -c ' codex ')" "$CODEX_N"
check "noise is hidden by default" "$([ "$(runs_in list --codex 2>/dev/null | grep -m1 'session(s) in' | cut -d' ' -f1)" -lt "$CODEX_N" ] && echo yes)" "yes"
check "a bad limit is rejected"   "$(runs_in list --limit abc 2>&1 | grep -c 'whole number')" "1"
check "piped output has no escape codes" "$(runs_in list --codex --limit 3 2>/dev/null | grep -c "\\[3")" "0"
check "the project column is shown" "$(runs_in list --codex --limit 3 2>/dev/null | grep -c 'project')" "1"

head2 "a session still being written to"
# Must be inside the scope, or the guard has nothing to hold back.
LIVE=$(find "$SB/claude/projects/$(printf '%s' "$SCOPE" | tr -c 'A-Za-z0-9' '-')" -maxdepth 1 -name '*.jsonl' -size -16M | head -1)
touch "$LIVE"
check "is held back"       "$(runs_in import --claude --dry-run 2>/dev/null | grep -c 'still running')" "1"
check "--include-live imports it" "$(runs_in import --claude --include-live --dry-run 2>/dev/null | grep -c 'still running')" "0"
touch -t 202601010000 "$LIVE"
check "and not once it is quiet" "$(runs_in import --claude --dry-run 2>/dev/null | grep -c 'still running')" "0"

head2 "naming a session is enough on its own"
REF=$(runs_in list --claude --include-noise 2>/dev/null | sed -n '4p' | awk '{print $3}')
check "no --path needed for a named session" "$(run import "$REF" --dry-run 2>&1 | grep -c 'to import')" "1"
check "a scope it is not in does not reject it" "$(run import --path "$HOME" "$REF" --dry-run 2>&1 | grep -c 'to import')" "1"
check "--path is still required without one" "$(run import --dry-run 2>&1 | grep -c 'path <dir> is required')" "1"
check "an unmatched reference says one thing" "$(run import zzzzzzzz --dry-run 2>&1 | grep -c 'no session matches')" "1"
check "a named session gets a reason, not a tally" "$(run import "$REF" --dry-run 2>&1 | grep -c 'to import')" "1"

head2 "import --dry-run writes nothing"
BEFORE=$(q "select count(*) from orchestration_events")
runs_in import --dry-run >/dev/null 2>&1
check "event count unchanged" "$(q 'select count(*) from orchestration_events')" "$BEFORE"

head2 "import (claude)"
runs_in import --claude >/dev/null 2>&1
CL=$(q "select count(*) from provider_session_runtime where thread_id glob 'import:claudeAgent:*'")
[ "$CL" -gt 0 ] && ok "imported $CL claude thread(s)" || bad "imported no claude threads"
check "cursors carry a resume key" \
  "$(q "select count(*) from provider_session_runtime where thread_id glob 'import:claudeAgent:*' and json_extract(resume_cursor_json,'\$.resume') is null")" "0"

head2 "import (codex)"
runs_in import --codex --drop-generated >/dev/null 2>&1
CX=$(q "select count(*) from provider_session_runtime where thread_id glob 'import:codex:*'")
[ "$CX" -gt 0 ] && ok "imported $CX codex thread(s)" || bad "imported no codex threads"
check "cursors have NO resume key" \
  "$(q "select count(*) from provider_session_runtime where thread_id glob 'import:codex:*' and json_extract(resume_cursor_json,'\$.resume') is not null")" "0"
check "cursor threadId is the session id" \
  "$(q "select count(*) from provider_session_runtime where thread_id glob 'import:codex:*' and json_extract(resume_cursor_json,'\$.threadId') <> replace(thread_id,'import:codex:','')")" "0"

head2 "imported threads land active"
check "one unsettle per imported thread" \
  "$(q "select count(*) from orchestration_events where event_type='thread.unsettled' and stream_id glob 'import:*'")" "$((CL+CX))"
check "each is pinned active, not merely unsettled" \
  "$(q "select count(*) from orchestration_events where event_type='thread.unsettled' and stream_id glob 'import:*' and json_extract(payload_json,'\$.reason') <> 'user'")" "0"

head2 "event log integrity"
check "no stream_version gaps or dupes" \
  "$(q "select count(*) from (select stream_id, min(stream_version) mn, max(stream_version) mx, count(*) n, count(distinct stream_version) d from orchestration_events where stream_id glob 'import:*' group by stream_id) where mn<>0 or mx<>n-1 or d<>n")" "0"
check "every event has a receipt" \
  "$(q "select count(*) from orchestration_events e where e.stream_id glob 'import:*' and not exists (select 1 from orchestration_command_receipts r where r.command_id=e.command_id)")" "0"
check "every thread has a settled event" \
  "$(q "select count(*) from (select stream_id from orchestration_events where stream_id glob 'import:*' group by stream_id having sum(event_type='thread.settled')<>1)")" "0"
check "no stream created twice" \
  "$(q "select count(*) from (select stream_id from orchestration_events where event_type='thread.created' and stream_id glob 'import:*' group by stream_id having count(*)>1)")" "0"
check "roles are only user/assistant" \
  "$(q "select count(*) from orchestration_events where stream_id glob 'import:*' and event_type='thread.message-sent' and json_extract(payload_json,'\$.role') not in ('user','assistant')")" "0"

head2 "idempotency"
# Re-run exactly what was imported; anything else compares different filters.
check "claude re-import plans nothing" "$(runs_in import --claude --dry-run 2>/dev/null | grep -m1 'to import' | cut -d' ' -f1)" "0"
check "codex re-import plans nothing"  "$(runs_in import --codex --drop-generated --dry-run 2>/dev/null | grep -m1 'to import' | cut -d' ' -f1)" "0"

head2 "runs"
check "two imports are two runs" "$(run runs 2>/dev/null | grep -cE '^  [0-9a-f]{8}  ')" "2"
# Once T3 resumes an imported thread it writes to that stream under its own correlation id.
S=$(q "select stream_id from orchestration_events where stream_id glob 'import:*' limit 1")
sqlite3 "$SB/t3/userdata/state.sqlite" "insert into orchestration_events
 (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,correlation_id,actor_kind,payload_json,metadata_json)
 values ('ev-t3-touch','thread','$S',9999,'thread.session-set','2026-09-29T06:00:00.000Z','server:x','server:x','server','{}','{}');"
check "T3 touching an import is not a run" "$(run runs 2>/dev/null | grep -c 'server:x')" "0"
check "the real runs survive it" "$(run runs 2>/dev/null | grep -cE '^  [0-9a-f]{8}  ')" "2"
sqlite3 "$SB/t3/userdata/state.sqlite" "delete from orchestration_events where event_id='ev-t3-touch';"

head2 "undo pops an unread run whole"
EV=$(q "select count(*) from orchestration_events")
run undo --dry-run >/dev/null 2>&1
check "dry-run changes nothing" "$(q 'select count(*) from orchestration_events')" "$EV"
run undo >/dev/null 2>&1
check "codex streams gone"  "$(q "select count(distinct stream_id) from orchestration_events where stream_id glob 'import:codex:*'")" "0"
check "codex bindings gone" "$(q "select count(*) from provider_session_runtime where thread_id glob 'import:codex:*'")" "0"
check "the other run is untouched" "$(q "select count(distinct stream_id) from orchestration_events where stream_id glob 'import:claudeAgent:*'")" "$CL"
check "its sessions are importable again" "$(runs_in import --codex --drop-generated --dry-run 2>/dev/null | grep -m1 'to import' | cut -d' ' -f1)" "$CX"

head2 "undo compensates once T3 has read a run"
sqlite3 "$SB/t3/userdata/state.sqlite" "update projection_state set last_applied_sequence = (select max(sequence) from orchestration_events);"
# However many threads the surviving run holds; noise filtering changes the count, not the rule.
LEFT=$(q "select count(distinct stream_id) from orchestration_events where event_type='thread.created' and stream_id glob 'import:*' and stream_id not in (select stream_id from orchestration_events where event_type='thread.deleted')")
run undo >/dev/null 2>&1
run undo >/dev/null 2>&1
check "streams are kept"                "$(q "select count(distinct stream_id) from orchestration_events where stream_id glob 'import:claudeAgent:*'")" "$CL"
check "one thread.deleted per thread"   "$(q "select count(*) from orchestration_events where event_type='thread.deleted' and stream_id glob 'import:*'")" "$LEFT"
run undo >/dev/null 2>&1
check "a second undo adds nothing"      "$(q "select count(*) from orchestration_events where event_type='thread.deleted' and stream_id glob 'import:*'")" "$LEFT"

head2 "guards"
cp ~/.t3/userdata/server-runtime.json "$SB/t3/userdata/" 2>/dev/null
runs_in import >/dev/null 2>&1; check "refuses while T3 runs" "$?" "1"
rm -f "$SB/t3/userdata/server-runtime.json"
sqlite3 "$SB/t3/userdata/state.sqlite" "ALTER TABLE projection_thread_messages ADD COLUMN drift_probe TEXT;" 2>/dev/null
run doctor >/dev/null 2>&1;            check "doctor flags schema drift" "$?" "1"
runs_in import >/dev/null 2>&1;            check "import refuses on drift"   "$?" "1"
runs_in import --force --dry-run >/dev/null 2>&1; check "--force overrides" "$?" "0"

head2 "a compensated run stays claimed"
check "its sessions are not offered again" "$(runs_in import --claude --dry-run 2>/dev/null | grep -m1 'to import' | cut -d' ' -f1)" "0"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && echo "sandbox: $SB (delete when done)" 
exit $((FAIL > 0))
