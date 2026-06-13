#!/usr/bin/env bash
# state.sh — HUD state read/write for ~/.cache/mmt/state.json.
# Flat, one-field-per-line JSON so statusline.sh can parse it with sed (no jq).
# Writes are serialized with an mkdir lock; the HUD is non-critical, so a failed
# lock skips the update rather than blocking the delegation.

MMT_STATE_DIR="${MMT_STATE_DIR:-$HOME/.cache/mmt}"
MMT_STATE_FILE="${MMT_STATE_FILE:-$MMT_STATE_DIR/state.json}"
MMT_STATE_LOCK="$MMT_STATE_DIR/.lock"

mmt_now_ms() { date +%s%3N 2>/dev/null || echo 0; }

_mmt_json_esc() {  # minimal JSON string escaping
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

_mmt_get_num() {  # key default -> integer field from state file
  local v
  v="$(sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9]*\).*/\1/p" "$MMT_STATE_FILE" 2>/dev/null | head -1)"
  printf '%s' "${v:-$2}"
}

_mmt_get_str() {  # key default -> string field from state file
  local v
  v="$(sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\(.*\)\".*/\1/p" "$MMT_STATE_FILE" 2>/dev/null | head -1)"
  printf '%s' "${v:-$2}"
}

_mmt_lock() {
  mkdir -p "$MMT_STATE_DIR" 2>/dev/null
  local i=0
  while ! mkdir "$MMT_STATE_LOCK" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -gt 40 ]; then
      rm -rf "$MMT_STATE_LOCK" 2>/dev/null   # break a stale lock, try once more
      mkdir "$MMT_STATE_LOCK" 2>/dev/null && return 0
      return 1
    fi
    sleep 0.05 2>/dev/null || sleep 1
  done
  return 0
}
_mmt_unlock() { rmdir "$MMT_STATE_LOCK" 2>/dev/null || true; }

# Write the full state file from the current MMT_S_* shell variables.
# Resilient to transient msys rename hiccups: falls back to a direct copy.
_mmt_state_flush() {
  local tmp="$MMT_STATE_FILE.tmp.$$.${RANDOM:-0}"
  {
    printf '{\n'
    printf '  "schema": 1,\n'
    printf '  "updated": %s,\n'      "$(mmt_now_ms)"
    printf '  "open": %s,\n'         "${MMT_S_open:-0}"
    printf '  "calls": %s,\n'        "${MMT_S_calls:-0}"
    printf '  "fallbacks": %s,\n'    "${MMT_S_fallbacks:-0}"
    printf '  "errors": %s,\n'       "${MMT_S_errors:-0}"
    printf '  "active_id": "%s",\n'        "$(_mmt_json_esc "${MMT_S_active_id:-}")"
    printf '  "active_backend": "%s",\n'   "$(_mmt_json_esc "${MMT_S_active_backend:-}")"
    printf '  "active_model": "%s",\n'     "$(_mmt_json_esc "${MMT_S_active_model:-}")"
    printf '  "active_rule": "%s",\n'      "$(_mmt_json_esc "${MMT_S_active_rule:-}")"
    printf '  "active_started": %s,\n'     "${MMT_S_active_started:-0}"
    printf '  "last_id": "%s",\n'          "$(_mmt_json_esc "${MMT_S_last_id:-}")"
    printf '  "last_backend": "%s",\n'     "$(_mmt_json_esc "${MMT_S_last_backend:-}")"
    printf '  "last_model": "%s",\n'       "$(_mmt_json_esc "${MMT_S_last_model:-}")"
    printf '  "last_rule": "%s",\n'        "$(_mmt_json_esc "${MMT_S_last_rule:-}")"
    printf '  "last_code": %s,\n'          "${MMT_S_last_code:-0}"
    printf '  "last_dur_ms": %s,\n'        "${MMT_S_last_dur_ms:-0}"
    printf '  "last_out_chars": %s,\n'     "${MMT_S_last_out_chars:-0}"
    printf '  "approx_in_chars": %s,\n'    "${MMT_S_approx_in_chars:-0}"
    printf '  "approx_out_chars": %s\n'    "${MMT_S_approx_out_chars:-0}"
    printf '}\n'
  } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$MMT_STATE_FILE" 2>/dev/null \
    || cat "$tmp" > "$MMT_STATE_FILE" 2>/dev/null   # fallback if rename hiccups
  rm -f "$tmp" 2>/dev/null
  return 0
}

# Load current counters into MMT_S_* (called under lock).
_mmt_state_load() {
  MMT_S_open="$(_mmt_get_num open 0)"
  MMT_S_calls="$(_mmt_get_num calls 0)"
  MMT_S_fallbacks="$(_mmt_get_num fallbacks 0)"
  MMT_S_errors="$(_mmt_get_num errors 0)"
  MMT_S_approx_in_chars="$(_mmt_get_num approx_in_chars 0)"
  MMT_S_approx_out_chars="$(_mmt_get_num approx_out_chars 0)"
}

mmt_state_init() {
  mkdir -p "$MMT_STATE_DIR" 2>/dev/null
  [ -f "$MMT_STATE_FILE" ] && return 0
  local locked=0; _mmt_lock && locked=1
  MMT_S_open=0 MMT_S_calls=0 MMT_S_fallbacks=0 MMT_S_errors=0
  MMT_S_approx_in_chars=0 MMT_S_approx_out_chars=0
  _mmt_state_flush
  [ "$locked" = 1 ] && _mmt_unlock
  return 0
}

# mmt_state_start <id> <backend> <model> <rule> <in_chars>
# Always writes (lock only reduces races, never gates the write — HUD must update).
mmt_state_start() {
  local locked=0; _mmt_lock && locked=1
  _mmt_state_load
  MMT_S_open=$(( ${MMT_S_open:-0} + 1 ))
  MMT_S_active_id="$1" MMT_S_active_backend="$2" MMT_S_active_model="$3" MMT_S_active_rule="$4"
  MMT_S_active_started="$(mmt_now_ms)"
  MMT_S_approx_in_chars=$(( ${MMT_S_approx_in_chars:-0} + ${5:-0} ))
  _mmt_state_flush
  [ "$locked" = 1 ] && _mmt_unlock
  return 0
}

# mmt_state_end <id> <backend> <model> <rule> <code> <dur_ms> <out_chars> <fallback_inc>
mmt_state_end() {
  local locked=0; _mmt_lock && locked=1
  _mmt_state_load
  [ "${MMT_S_open:-0}" -gt 0 ] && MMT_S_open=$(( MMT_S_open - 1 ))
  MMT_S_calls=$(( ${MMT_S_calls:-0} + 1 ))
  [ "${8:-0}" != "0" ] && MMT_S_fallbacks=$(( ${MMT_S_fallbacks:-0} + ${8:-0} ))
  [ "${5:-0}" != "0" ] && MMT_S_errors=$(( ${MMT_S_errors:-0} + 1 ))
  MMT_S_active_id="" MMT_S_active_backend="" MMT_S_active_model="" MMT_S_active_rule="" MMT_S_active_started=0
  MMT_S_last_id="$1" MMT_S_last_backend="$2" MMT_S_last_model="$3" MMT_S_last_rule="$4"
  MMT_S_last_code="${5:-0}" MMT_S_last_dur_ms="${6:-0}" MMT_S_last_out_chars="${7:-0}"
  MMT_S_approx_out_chars=$(( ${MMT_S_approx_out_chars:-0} + ${7:-0} ))
  _mmt_state_flush
  [ "$locked" = 1 ] && _mmt_unlock
  return 0
}
