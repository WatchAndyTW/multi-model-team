#!/usr/bin/env bash
# statusline.sh — one-line HUD for Claude Code Desktop. Reads ~/.cache/mmt/state.json.
# Must be fast (Claude Code re-invokes it often), so this is FORK-FREE: one builtin
# read loop + bash parameter expansion. No sed/awk/jq/cat, no model calls.
# Claude Code passes session JSON on stdin; we don't read it.
#
#   Active: ⟳ agy·Gemini-3.1-Pro │ 2 open │ ~12k↓
#   Idle  : ◦ agy idle │ 5 calls · 1 fallback │ last 3.4s ✓
#   Empty : ◦ mmt idle

STATE="${MMT_STATE_FILE:-${MMT_STATE_DIR:-$HOME/.cache/mmt}/state.json}"

[ -f "$STATE" ] || { printf '◦ mmt idle\n'; exit 0; }

declare -A S
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in *'"'*) ;; *) continue ;; esac   # only "key": value lines
  key="${line#*\"}"; key="${key%%\"*}"             # first quoted token
  val="${line#*:}"                                 # after the colon
  val="${val#"${val%%[![:space:]]*}"}"             # ltrim
  val="${val%,}"                                   # strip trailing comma
  val="${val#\"}"; val="${val%\"}"                 # unquote strings (no-op for nums)
  S["$key"]="$val"
done < "$STATE"

open="${S[open]:-0}"
calls="${S[calls]:-0}"
fallbacks="${S[fallbacks]:-0}"
last_code="${S[last_code]:-0}"
last_dur="${S[last_dur_ms]:-0}"
out_chars="${S[approx_out_chars]:-0}"
abk="${S[active_backend]}"
amodel="${S[active_model]}"
lbk="${S[last_backend]}"

short_model() { local m="$1"; m="${m%% (*}"; m="${m// /-}"; printf '%s' "$m"; }
human() { local c="${1:-0}"; if [ "$c" -ge 1000 ] 2>/dev/null; then printf '~%dk' "$(( c / 1000 ))"; else printf '~%d' "$c"; fi; }
dur()   { local ms="${1:-0}"; printf '%d.%ds' "$(( ms / 1000 ))" "$(( (ms % 1000) / 100 ))"; }

if [ "$open" -gt 0 ] 2>/dev/null; then
  printf '⟳ %s·%s │ %s open │ %s↓\n' "${abk:-agy}" "$(short_model "${amodel:-?}")" "$open" "$(human "$out_chars")"
elif [ "$calls" -gt 0 ] 2>/dev/null; then
  ok='✓'; [ "$last_code" = "0" ] || ok='✗'
  fbword='fallback'; [ "$fallbacks" = "1" ] || fbword='fallbacks'
  printf '◦ %s idle │ %s calls · %s %s │ last %s %s\n' "${lbk:-agy}" "$calls" "$fallbacks" "$fbword" "$(dur "$last_dur")" "$ok"
else
  printf '◦ mmt idle\n'
fi
