#!/usr/bin/env bash
# backends.sh — backend resolution + invocation. agy first; extensible per the roster.
# Expects the MMT_AGY_* vars to be loaded already (run.sh does:
#   eval "$(python config.py roster.toml agy-env)" ).
# Key fact (PROBES.md): agy needs a TTY, so on Windows we wrap it in winpty.

_mmt_is_windows() {
  case "$(uname -s 2>/dev/null)" in
    *MINGW*|*MSYS*|*CYGWIN*|*Windows*) return 0 ;;
    *) return 1 ;;
  esac
}

# Resolve the agy binary: $MMT_AGY_BIN -> PATH -> roster bin_candidates -> known paths.
mmt_resolve_agy() {
  if [ -n "${MMT_AGY_BIN:-}" ] && [ -x "${MMT_AGY_BIN}" ]; then
    printf '%s' "$MMT_AGY_BIN"; return 0
  fi
  if command -v "${MMT_AGY_CMD:-agy}" >/dev/null 2>&1; then
    command -v "${MMT_AGY_CMD:-agy}"; return 0
  fi
  local -a cands=()
  # From roster (literal '$VAR' substituted here, no eval).
  local c
  if [ -n "${MMT_AGY_BIN_CANDIDATES+x}" ]; then
    for c in "${MMT_AGY_BIN_CANDIDATES[@]}"; do
      c="${c//\$LOCALAPPDATA/${LOCALAPPDATA:-}}"
      c="${c//\$HOME/${HOME:-}}"
      cands+=("$c")
    done
  fi
  # Built-in fallbacks.
  [ -n "${LOCALAPPDATA:-}" ] && cands+=("$LOCALAPPDATA/agy/bin/agy.exe")
  cands+=("$HOME/AppData/Local/agy/bin/agy.exe")
  local u
  for c in "${cands[@]}"; do
    [ -n "$c" ] || continue
    if [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
    if command -v cygpath >/dev/null 2>&1; then
      u="$(cygpath -u "$c" 2>/dev/null || true)"
      [ -n "$u" ] && [ -x "$u" ] && { printf '%s' "$u"; return 0; }
    fi
  done
  return 1
}

# Should we wrap with winpty? (configured + Windows + not already a tty + winpty present)
_mmt_use_winpty() {
  [ "${MMT_AGY_USE_WINPTY:-1}" = "1" ] || return 1
  _mmt_is_windows || return 1
  command -v winpty >/dev/null 2>&1 || return 1
  return 0
}

# Build the argv prefix (winpty ... ) into the named array. Usage: _mmt_winpty_prefix ARR
_mmt_winpty_prefix() {
  local __arr="$1"
  if _mmt_use_winpty; then
    if [ -n "${MMT_AGY_WINPTY_FLAGS+x}" ]; then
      eval "$__arr=( winpty \"\${MMT_AGY_WINPTY_FLAGS[@]}\" )"
    else
      eval "$__arr=( winpty -Xallow-non-tty -Xplain )"
    fi
  else
    eval "$__arr=( )"
  fi
}

# Clean agy stdout: strip CR, drop winpty teardown noise, strip stray ANSI/escape
# sequences (CSI incl. intermediates, OSC, charset-select, and 2-char escapes), then
# trim trailing blank lines. -Xplain already suppresses ANSI; this is the backstop.
mmt_clean() {
  sed -e 's/\r$//' \
      -e '/^Assertion failed:.*winpty\.cc/d' \
      -e 's/\x1b\][^\x07\x1b]*\(\x07\|\x1b\\\)//g' \
      -e 's/\x1b\[[0-9;?]*[ -/]*[@-~]//g' \
      -e 's/\x1b[()][0-9A-Za-z]//g' \
      -e 's/\x1b[=>cM78]//g' \
  | sed -e ':a' -e '/^[[:space:]]*$/{$d;N;ba}'
}

# Health check: `agy --version` returns 0 with a version line. This runs DIRECTLY
# (no winpty) — --version is not TTY-gated, unlike the print/interactive flow, and
# wrapping it in winpty yields empty output (see PROBES.md).
mmt_agy_health() {
  local bin; bin="$(mmt_resolve_agy)" || return 1
  local out
  out="$(timeout 30 "$bin" "${MMT_AGY_HEALTH:---version}" </dev/null 2>/dev/null | tr -d '\r')"
  [ -n "$out" ] || return 1
  return 0
}

# Map a tier to an agy model string.
mmt_agy_model_for_tier() {
  case "$1" in
    cheap)    printf '%s' "${MMT_AGY_MODEL_CHEAP:-}" ;;
    standard) printf '%s' "${MMT_AGY_MODEL_STANDARD:-}" ;;
    *)        printf '%s' "${MMT_AGY_MODEL_STANDARD:-}" ;;
  esac
}

# Run "$@" with an OPEN, idle stdin. agy/winpty emit nothing if stdin is at EOF
# (e.g. /dev/null or a drained pipe — see PROBES.md), so we hold a pipe open with a
# background sleep for the duration and tear it down afterwards.
_mmt_with_open_stdin() {
  local secs="${MMT_STDIN_KEEPALIVE_SECS:-600}"
  local dir fifo rc kpid
  # Create the FIFO inside a PRIVATE temp dir (never a predictable/relative CWD path).
  dir="$(mktemp -d 2>/dev/null)"
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    fifo="$dir/in.fifo"
  else
    dir=""; fifo="${TMPDIR:-/tmp}/mmt.$$.${RANDOM:-0}.fifo"
  fi
  if mkfifo "$fifo" 2>/dev/null; then
    # Hold the FIFO open with a background sleep so agy never sees stdin EOF; reap it after.
    sleep "$secs" > "$fifo" &
    kpid=$!
    "$@" < "$fifo"
    rc=$?
    kill "$kpid" 2>/dev/null; wait "$kpid" 2>/dev/null
    rm -f "$fifo" 2>/dev/null
    [ -n "$dir" ] && rmdir "$dir" 2>/dev/null
    return $rc
  fi
  [ -n "$dir" ] && rm -rf "$dir" 2>/dev/null
  # Last resort (mkfifo unavailable): hold stdin open via an fd to a backgrounded sleep,
  # captured so we can close it immediately when the call returns.
  if exec {kfd}< <(sleep "$secs") 2>/dev/null; then
    "$@" <&"$kfd"
    rc=$?
    exec {kfd}<&- 2>/dev/null
    return $rc
  fi
  "$@"   # absolute last resort: inherit caller stdin
}

# Invoke agy. Args: <model> <prompt> [add_dir]
# Writes raw response to stdout, raw stderr to fd 2, returns agy's (timeout's) exit code.
mmt_agy_invoke() {
  local model="$1" prompt="$2" add_dir="${3:-}"
  local bin; bin="$(mmt_resolve_agy)" || return 127
  local -a pre; _mmt_winpty_prefix pre
  local -a cmd=( "$bin" "${MMT_AGY_ONESHOT:---print}" "$prompt" "${MMT_AGY_MODEL_FLAG:---model}" "$model" )
  if [ -n "${MMT_AGY_EXTRA+x}" ]; then cmd+=( "${MMT_AGY_EXTRA[@]}" ); fi
  if [ -n "$add_dir" ]; then cmd+=( "${MMT_AGY_ADD_DIR_FLAG:---add-dir}" "$add_dir" ); fi
  if _mmt_use_winpty; then
    _mmt_with_open_stdin timeout "${MMT_AGY_HARD_TIMEOUT:-6m}" "${pre[@]}" "${cmd[@]}"
  else
    # Non-winpty (e.g. Linux/mac agy): conventional headless redirect is safe.
    timeout "${MMT_AGY_HARD_TIMEOUT:-6m}" "${cmd[@]}" </dev/null
  fi
}

# Quota detection over captured out+err+code. Returns 0 if exhausted.
# Pure bash (no grep): msys grep can abort under rapid forking, and the patterns are
# plain substrings. Patterns must not contain glob metachars (* ? [) — ours don't.
mmt_quota_exhausted() {
  local out="$1" err="$2" code="$3"
  local c
  if [ -n "${MMT_AGY_QUOTA_EXIT_CODES+x}" ]; then
    for c in "${MMT_AGY_QUOTA_EXIT_CODES[@]}"; do
      [ -n "$c" ] && [ "$code" = "$c" ] && return 0
    done
  fi
  local blob="$out
$err"
  blob="${blob,,}"          # case-insensitive: lowercase the haystack (bash 4+)
  blob="${blob:0:16000}"    # bound the scan
  local p
  if [ -n "${MMT_AGY_QUOTA_PATTERNS+x}" ]; then
    for p in "${MMT_AGY_QUOTA_PATTERNS[@]}"; do
      [ -n "$p" ] || continue
      p="${p,,}"
      case "$blob" in
        *"$p"*) return 0 ;;
      esac
    done
  fi
  return 1
}
