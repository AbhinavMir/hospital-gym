#!/usr/bin/env bash
# Optional: load JSONL run records into a queryable SQLite db, WITHOUT any npm
# native dependency — uses the sqlite3 CLI if you have it (`brew install sqlite`).
# Usage: scripts/runs-to-sqlite.sh runs/*.jsonl  ->  runs.db
set -euo pipefail
out="${OUT:-runs.db}"
rm -f "$out"
sqlite3 "$out" 'CREATE TABLE event(file TEXT, kind TEXT, json TEXT);'
for f in "$@"; do
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    kind=$(printf '%s' "$line" | sed -n 's/.*"kind":"\([a-z]*\)".*/\1/p')
    esc=$(printf '%s' "$line" | sed "s/'/''/g")
    sqlite3 "$out" "INSERT INTO event VALUES('$(basename "$f")','$kind','$esc');"
  done < "$f"
done
echo "wrote $out — e.g.:  sqlite3 $out \"select json_extract(json,'\$.reward') from event where kind='result'\""
