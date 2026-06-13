#!/usr/bin/env bash
# team.sh — parallel agy fan-out for /team.
#
#   team.sh --plan <plan.json> [--gemini-cap N] [--root <pluginRoot>]
#
# Runs the AGY (Gemini) subtasks from plan.json through run.sh IN PARALLEL (bounded by
# --gemini-cap), printing each result in a delimited block. NATIVE subtasks are NOT run
# here — they're listed so the caller (Claude) solves them in-context / via subagents.
#
# Injection-safe: subtask text never touches a shell. team_plan.py writes each task to a
# file; run.sh reads it on stdin (forced agy decision so routing matches the plan).
set -uo pipefail

MMT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$MMT_ROOT/scripts/lib/common.sh"

PLAN="" GCAP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --plan)         PLAN="${2:-}"; shift 2 ;;
    --plan=*)       PLAN="${1#*=}"; shift ;;
    --gemini-cap)   GCAP="${2:-}"; shift 2 ;;
    --gemini-cap=*) GCAP="${1#*=}"; shift ;;
    --root)         MMT_ROOT="${2:-}"; shift 2 ;;
    --root=*)       MMT_ROOT="${1#*=}"; shift ;;
    *) echo "team.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PLAN" ] && [ -f "$PLAN" ] || { echo "team.sh: --plan <file> required" >&2; exit 2; }
PY="$(mmt_find_python || true)"
[ -n "$PY" ] || { echo "team.sh: python3 with tomllib required" >&2; exit 2; }

case "$GCAP" in ''|*[!0-9]*) GCAP=4 ;; esac
[ "$GCAP" -lt 1 ]  2>/dev/null && GCAP=1
[ "$GCAP" -gt 16 ] 2>/dev/null && GCAP=16   # match team_spec / workflow ceiling

WORK="$(mktemp -d 2>/dev/null)" || { echo "team.sh: mktemp failed" >&2; exit 1; }
trap 'rm -rf "$WORK" 2>/dev/null' EXIT INT TERM

# team_plan.py writes <WORK>/<idx>.task and prints a manifest. We address task files by
# $WORK/<idx>.task (msys form we control) — NOT the path column, which native python
# echoes back in Windows form that msys bash can't reliably reopen (short-name mismatch).
MANIFEST="$("$PY" "$MMT_ROOT/scripts/lib/team_plan.py" "$PLAN" "$WORK" 2>"$WORK/plan.err")"
plan_rc=$?
if [ "$plan_rc" -ne 0 ]; then
  echo "team.sh: plan parse failed (rc=$plan_rc):" >&2
  cat "$WORK/plan.err" >&2 2>/dev/null
  exit "$plan_rc"
fi
# Surface any per-entry skip diagnostics (dropped subtasks) before the temp dir is wiped.
[ -s "$WORK/plan.err" ] && cat "$WORK/plan.err" >&2 2>/dev/null

RUN="$MMT_ROOT/scripts/run.sh"

agy_idx=() agy_label=() agy_tier=()
nat_idx=() nat_label=() nat_tier=()
while IFS=$'\t' read -r be idx label tier _file; do
  [ -n "${be:-}" ] || continue
  case "$be" in AGY|NATIVE) : ;; *) continue ;; esac     # only known backends
  case "$idx" in ''|*[!0-9]*) continue ;; esac           # idx must be a plain integer
  if [ "$be" = "AGY" ]; then
    agy_idx+=("$idx"); agy_label+=("$label"); agy_tier+=("$tier")
  else
    nat_idx+=("$idx"); nat_label+=("$label"); nat_tier+=("$tier")
  fi
done <<< "$MANIFEST"

n=${#agy_idx[@]}

# Dispatch AGY subtasks in parallel, throttled to GCAP concurrent run.sh processes.
launch() {  # array-index i
  local i="$1" idx="${agy_idx[$1]}"
  local dec="{\"backend\":\"agy\",\"model\":\"\",\"tier\":\"${agy_tier[$i]}\",\"rule\":\"team\",\"native\":false}"
  bash "$RUN" --decision "$dec" < "$WORK/$idx.task" > "$WORK/$idx.out" 2> "$WORK/$idx.err" &
}
for (( i=0; i<n; i++ )); do
  while [ "$(jobs -rp | wc -l)" -ge "$GCAP" ]; do wait -n 2>/dev/null || sleep 0.1; done
  launch "$i"
done
wait 2>/dev/null || true

# last non-winpty stderr line, pure bash (msys grep can abort under forking — CLAUDE.md).
err_tail() {
  local f="$1" line last=""
  [ -s "$f" ] || return 0
  while IFS= read -r line; do
    case "$line" in *winpty.cc*) continue ;; esac
    last="$line"
  done < "$f"
  printf '%s' "$last"
}

# Emit results.
printf '===MMT-TEAM dispatch: %d agy (cap=%d), %d native ===\n' "$n" "$GCAP" "${#nat_idx[@]}"
for (( i=0; i<n; i++ )); do
  idx="${agy_idx[$i]}"
  out="$WORK/$idx.out"
  if [ -s "$out" ] && IFS= read -r first < "$out" && [ "${first#MMT_NATIVE_HANDOFF}" != "$first" ]; then
    # agy was unavailable/exhausted and run.sh punted to native — label it honestly.
    printf '\n--- AGY [%s] (tier=%s) -> NATIVE HANDOFF (agy unavailable; solve in-context) ---\n' \
      "${agy_label[$i]}" "${agy_tier[$i]}"
    cat "$out" 2>/dev/null
    continue
  fi
  printf '\n--- AGY [%s] (tier=%s) ---\n' "${agy_label[$i]}" "${agy_tier[$i]}"
  cat "$out" 2>/dev/null
  if [ ! -s "$out" ]; then
    e="$(err_tail "$WORK/$idx.err")"
    [ -n "$e" ] && printf '[stderr] %s\n' "$e"
  fi
done
for (( k=0; k<${#nat_idx[@]}; k++ )); do
  printf '\n--- NATIVE [%s] (tier=%s) — solve in-context ---\n' "${nat_label[$k]}" "${nat_tier[$k]}"
  cat "$WORK/${nat_idx[$k]}.task" 2>/dev/null; printf '\n'
done
printf '\n===MMT-TEAM end ===\n'
