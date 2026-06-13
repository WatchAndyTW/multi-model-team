#!/usr/bin/env bash
# heavy-read-guard.sh — narrow PreToolUse guard for the multi-model-team plugin.
#
# Fires only when Claude is about to Read a LARGE file with an RE/dump-ish extension.
# In that case it DENIES the direct read and tells Claude to delegate the ingestion
# (bulk-summarizer / --add-dir) instead of pulling a huge blob into context. Everything
# else is allowed untouched. Fails OPEN: any uncertainty -> allow (never wrongly block).
#
# Tunables (env):
#   MMT_HOOK_MAX_BYTES   size threshold in bytes      (default 51200 = 50 KiB)
#   MMT_HOOK_EXTS        space-separated extensions   (default "dump il2cpp bin dmp sym pb")
#   MMT_HOOK_DISABLE     set to 1 to disable entirely
set -u

[ "${MMT_HOOK_DISABLE:-0}" = "1" ] && exit 0

payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || exit 0   # nothing to inspect -> allow

MAX_BYTES="${MMT_HOOK_MAX_BYTES:-51200}"
EXTS="${MMT_HOOK_EXTS:-dump il2cpp bin dmp sym pb}"

# Parse the file_path out of the PreToolUse payload. Prefer python (robust JSON);
# if unavailable, fail open.
PY=""
for c in python3 python; do command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }; done
[ -n "$PY" ] || exit 0

file_path="$(printf '%s' "$payload" | "$PY" -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get("tool_input", {}).get("file_path", ""))
except Exception:
    print("")
' 2>/dev/null)"

[ -n "$file_path" ] || exit 0
[ -f "$file_path" ] || exit 0   # not a readable file (e.g. about to be created) -> allow

# Extension check (case-insensitive).
base="${file_path##*/}"
ext="${base##*.}"
ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
match=0
for e in $EXTS; do [ "$ext" = "$e" ] && { match=1; break; }; done
[ "$match" = "1" ] || exit 0   # not a guarded extension -> allow

# Size check.
size="$(wc -c < "$file_path" 2>/dev/null | tr -d ' ')"
[ -n "$size" ] || exit 0
[ "$size" -gt "$MAX_BYTES" ] 2>/dev/null || exit 0   # small enough -> allow

kib=$(( size / 1024 ))
reason="multi-model-team: '$base' is ${kib} KiB. Reading it straight into context is \
token-expensive. Delegate the ingestion instead: spawn the bulk-summarizer agent (or run \
\$CLAUDE_PLUGIN_ROOT/scripts/run.sh with --add-dir \"$(dirname "$file_path")\") so agy reads \
it on Google's quota and returns a compact, grounded extract. If you truly need the raw \
bytes (e.g. precise RE work), re-issue the Read -- this guard only fires once per call."

# Deny this Read and explain. (PreToolUse permissionDecision schema.)
# Build the whole JSON in one python pass (reason via env var, no fragile nested quoting).
MMT_REASON="$reason" "$PY" -c '
import os, json
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": os.environ.get("MMT_REASON", ""),
}}, separators=(",", ":")))'
exit 0
