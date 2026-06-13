#!/usr/bin/env bash
# route.sh — task text -> routing decision JSON. Pure decision logic, no model calls.
#
# Usage:
#   route.sh [--preset budget|balanced|premium] [--explain] "<task text>"
#   echo "<task text>" | route.sh
#
# Output (default): one JSON line, e.g.
#   {"backend":"agy","model":"Gemini 3.1 Pro (Low)","tier":"standard",
#    "rule":"standard-coding","native":false,"preset":"balanced",
#    "score":{"chars":1234,"types":["frontend","react-component"]}}
#
# --explain adds a human-readable breakdown on stderr (used by /route-test).
set -euo pipefail

MMT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MMT_ROOT
# shellcheck source=lib/common.sh
. "$MMT_ROOT/scripts/lib/common.sh"
# shellcheck source=lib/score.sh
. "$MMT_ROOT/scripts/lib/score.sh"

ROSTER="${MMT_ROSTER:-$MMT_ROOT/config/roster.toml}"
PRESET=""
EXPLAIN=0
TASK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --preset) PRESET="${2:-}"; shift 2 ;;
    --preset=*) PRESET="${1#*=}"; shift ;;
    --explain) EXPLAIN=1; shift ;;
    --) shift; TASK="$*"; break ;;
    -*) echo "route.sh: unknown flag: $1" >&2; exit 2 ;;
    *) TASK="$*"; break ;;
  esac
done

# Fall back to stdin if no task text given as an argument.
if [ -z "$TASK" ] && [ ! -t 0 ]; then
  TASK="$(cat)"
fi
if [ -z "$TASK" ]; then
  echo "route.sh: no task text (pass as arg or stdin)" >&2
  exit 2
fi

CHARS="$(mmt_char_count "$TASK")"
TYPES="$(mmt_classify "$TASK")"
TYPES_CSV="$(printf '%s' "$TYPES" | tr ' ' ',')"

if ! PY="$(mmt_find_python)"; then
  echo "route.sh: no python3 with tomllib found (need 3.11+)" >&2
  # Degrade to a safe Sonnet decision rather than failing the caller.
  printf '{"backend":"native","model":"native:sonnet","tier":"sonnet","rule":"no-python","native":true,"preset":"%s","score":{"chars":%s,"types":[]}}\n' \
    "${PRESET:-balanced}" "$CHARS"
  exit 0
fi

DECISION="$("$PY" "$MMT_ROOT/scripts/lib/match.py" "$ROSTER" "$CHARS" "$TYPES_CSV" "$PRESET")"

if [ "$EXPLAIN" = "1" ]; then
  {
    echo "── route.sh decision ──────────────────────────────"
    echo "task chars : $CHARS"
    echo "task types : ${TYPES:-<none>}"
    echo "preset     : ${PRESET:-<config default>}"
    echo "roster     : $ROSTER"
    echo "decision   : $DECISION"
    echo "───────────────────────────────────────────────────"
  } >&2
fi

printf '%s\n' "$DECISION"
