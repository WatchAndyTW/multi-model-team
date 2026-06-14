#!/usr/bin/env bash
# run.sh — execute a delegation: route -> fallback chain -> backend -> clean output.
# Writes HUD state on call start/end. On exhaustion (or a native decision) prints a
# native-handoff sentinel so the caller (delegate agent / Opus) solves it in-context.
#
# Usage:
#   run.sh [--preset P] [--add-dir DIR] [--sandbox] [--decision JSON] "<task text>"
#   echo "<task text>" | run.sh
set -uo pipefail

MMT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MMT_ROOT
. "$MMT_ROOT/scripts/lib/common.sh"
. "$MMT_ROOT/scripts/lib/state.sh"
. "$MMT_ROOT/scripts/lib/backends.sh"

ROSTER="${MMT_ROSTER:-$MMT_ROOT/config/roster.json}"
PRESET="" ADD_DIR="" DECISION="" SANDBOX=0 TASK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --preset)   PRESET="${2:-}"; shift 2 ;;
    --preset=*) PRESET="${1#*=}"; shift ;;
    --add-dir)  ADD_DIR="${2:-}"; shift 2 ;;
    --add-dir=*) ADD_DIR="${1#*=}"; shift ;;
    --decision) DECISION="${2:-}"; shift 2 ;;
    --sandbox)  SANDBOX=1; shift ;;
    --)         shift; TASK="$*"; break ;;
    -*)         echo "run.sh: unknown flag: $1" >&2; exit 2 ;;
    *)          TASK="$*"; break ;;
  esac
done
if [ -z "$TASK" ] && [ ! -t 0 ]; then TASK="$(cat)"; fi
if [ -z "$TASK" ]; then echo "run.sh: no task text" >&2; exit 2; fi

PY="$(mmt_find_python || true)"

native_sentinel() {  # tier rule reason
  printf 'MMT_NATIVE_HANDOFF tier=%s rule=%s reason="%s"\n' "$1" "$2" "$3"
  printf 'This task was routed to native Claude (no agy offload). Solve it directly in-context at the indicated tier.\n'
}

# ---- 1. Decision -----------------------------------------------------------
if [ -z "$DECISION" ]; then
  DECISION="$(printf '%s' "$TASK" | "$MMT_ROOT/scripts/route.sh" ${PRESET:+--preset "$PRESET"} 2>/dev/null)"
fi

D_backend="native"; D_model="native:sonnet"; D_tier="sonnet"; D_rule="catch-all-safe"; D_native=1
if [ -n "$PY" ] && [ -n "$DECISION" ]; then
  eval "$(printf '%s' "$DECISION" | "$PY" -c '
import sys, json, shlex
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)   # emit nothing -> the safe native defaults above survive (fail closed)
for k in ("backend", "model", "tier", "rule"):
    print("D_%s=%s" % (k, shlex.quote(str(d.get(k, "")))))
print("D_native=%s" % ("1" if d.get("native") else "0"))
')"
fi
# Belt-and-suspenders: a parsed-but-empty backend must never fail open to agy.
[ -n "$D_backend" ] || { D_backend="native"; D_native=1; }

# ---- 2. Load defaults + init state ----------------------------------------
# Backend-specific config (MMT_BE_*) is loaded per hop inside the fallback chain below,
# since each hop may be a different backend. Only the defaults are global here.
if [ -n "$PY" ]; then
  eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$ROSTER" defaults-env 2>/dev/null)" || true
fi
mmt_state_init

# Balance the HUD 'open' gauge if we're killed (SIGINT/SIGTERM) mid-call. Without this,
# an interrupted delegation would leave open incremented forever in state.json.
CALL_OPEN=0
CUR_BE=""
_mmt_on_signal() {
  [ "${CALL_OPEN:-0}" = "1" ] || return 0
  mmt_state_end "${CALL_ID:-}" "${CUR_BE:-backend}" "${model:-}" "${D_rule:-}" 130 0 0 0
  CALL_OPEN=0
}
trap _mmt_on_signal INT TERM

IN_CHARS="$(printf '%s' "$TASK" | wc -m | tr -d ' ')"
FULL_PROMPT="Return only the result, no preamble.

$TASK"
CALL_ID="$(printf '%s' "$RANDOM$RANDOM" | cut -c1-6)"

# ---- 3. Native decision -> immediate handoff -------------------------------
if [ "$D_native" = "1" ] || [ "$D_backend" = "native" ]; then
  native_sentinel "$D_tier" "$D_rule" "router selected native backend"
  exit 0
fi

# ---- 4. Build fallback chain: chosen backend + quota_fallback (deduped) -----
declare -a CHAIN=( "$D_backend" )
if [ -n "${MMT_QUOTA_FALLBACK+x}" ]; then
  for e in "${MMT_QUOTA_FALLBACK[@]}"; do
    dup=0; for x in "${CHAIN[@]}"; do [ "$x" = "$e" ] && dup=1; done
    [ "$dup" = "0" ] && CHAIN+=( "$e" )
  done
fi

FALLBACK_COUNT=0
for entry in "${CHAIN[@]}"; do
  case "$entry" in
    native|native:*)
      tier="${entry#native}"; tier="${tier#:}"; tier="${tier:-$D_tier}"
      native_sentinel "$tier" "$D_rule" "backend options exhausted; falling back to native"
      exit 0
      ;;
    *)
      be="$entry"; CUR_BE="$be"
      # Load this backend's config (MMT_BE_*). Skip the hop if it can't be read.
      if [ -n "$PY" ]; then
        if ! eval "$("$PY" "$MMT_ROOT/scripts/lib/config.py" "$ROSTER" backend-env "$be" 2>/dev/null)"; then
          echo "run.sh: cannot load backend '$be' (skipped)" >&2
          FALLBACK_COUNT=$((FALLBACK_COUNT + 1)); continue
        fi
      fi
      # Disabled or unknown backend -> skip (falls through to the next hop / native).
      if [ "${MMT_BE_ENABLED:-0}" != "1" ]; then
        echo "run.sh: backend '$be' disabled or unknown (skipped)" >&2
        FALLBACK_COUNT=$((FALLBACK_COUNT + 1)); continue
      fi
      # Optional --sandbox: append the backend's sandbox flag for this hop only.
      if [ "$SANDBOX" = "1" ]; then
        MMT_BE_EXTRA=( ${MMT_BE_EXTRA[@]+"${MMT_BE_EXTRA[@]}"} "${MMT_BE_SANDBOX_FLAG:---sandbox}" )
      fi
      model="$(mmt_be_model_for_tier "$D_tier")"
      [ -n "$model" ] || model="$(mmt_be_model_for_tier standard)"
      # Health-gate: an unhealthy backend (or a kind with no invoker) is skipped.
      if ! mmt_be_health; then
        FALLBACK_COUNT=$((FALLBACK_COUNT + 1)); continue
      fi
      mmt_state_start "$CALL_ID" "$be" "$model" "$D_rule" "$IN_CHARS"; CALL_OPEN=1
      start_ms="$(mmt_now_ms)"
      err_file="$(mktemp 2>/dev/null || echo "$MMT_STATE_DIR/err.$$")"
      raw_out="$(mmt_be_invoke "$model" "$FULL_PROMPT" "$ADD_DIR" 2>"$err_file")"
      code=$?
      err="$(cat "$err_file" 2>/dev/null)"; rm -f "$err_file" 2>/dev/null
      end_ms="$(mmt_now_ms)"; dur=$(( end_ms - start_ms ))
      clean_out="$(printf '%s' "$raw_out" | mmt_clean)"
      out_chars="$(printf '%s' "$clean_out" | wc -m | tr -d ' ')"

      if mmt_quota_exhausted "$raw_out" "$err" "$code"; then
        mmt_state_end "$CALL_ID" "$be" "$model" "$D_rule" "$code" "$dur" "$out_chars" 1; CALL_OPEN=0
        FALLBACK_COUNT=$((FALLBACK_COUNT + 1)); continue
      fi
      if [ "$code" != "0" ] || [ -z "$clean_out" ]; then
        # Non-quota failure or suspicious empty output -> fall back to the next backend.
        # ($code is always set by code=$? above; pass it through honestly.)
        mmt_state_end "$CALL_ID" "$be" "$model" "$D_rule" "$code" "$dur" "$out_chars" 1; CALL_OPEN=0
        FALLBACK_COUNT=$((FALLBACK_COUNT + 1)); continue
      fi
      mmt_state_end "$CALL_ID" "$be" "$model" "$D_rule" 0 "$dur" "$out_chars" "$FALLBACK_COUNT"; CALL_OPEN=0
      printf '%s\n' "$clean_out"
      exit 0
      ;;
  esac
done

# ---- 5. Everything exhausted -> guaranteed native fallback ------------------
# Default the roster var so an unloaded/!malformed roster (set -u) can't abort here.
_df="${MMT_DEFAULT_FALLBACK:-native:sonnet}"
native_sentinel "${_df#native:}" "$D_rule" "all backends exhausted"
exit 0
