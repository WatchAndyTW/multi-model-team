#!/usr/bin/env bash
# score.sh — size + keyword-type scoring for the router.
# Sourced by route.sh; also runnable standalone:  score.sh "<task text>"
#
# Provides:
#   mmt_char_count <text>      -> prints integer char count
#   mmt_classify   <text>      -> prints space-separated, de-duplicated type tags
# Classification rules live in config/tags.txt (no code edits to tune).

# Resolve the plugin root from this file's location (scripts/lib/score.sh -> root).
if [ -z "${MMT_ROOT:-}" ]; then
  _mmt_score_self="${BASH_SOURCE[0]}"
  MMT_ROOT="$(cd "$(dirname "$_mmt_score_self")/../.." && pwd)"
fi
MMT_TAGS="${MMT_TAGS:-$MMT_ROOT/config/tags.txt}"

mmt_char_count() {
  # Count characters (not bytes). printf avoids trailing-newline inflation.
  local s="$1"
  printf '%s' "$s" | wc -m | tr -d ' '
}

mmt_classify() {
  local text="$1"
  [ -f "$MMT_TAGS" ] || { echo ""; return 0; }
  local out="" type pat
  # Read the tags file; first token is the type, remainder is the ERE.
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip blanks and comments.
    case "$line" in
      ''|\#*) continue ;;
    esac
    type=${line%%[[:space:]]*}                 # first token
    pat=${line#"$type"}                         # remainder
    pat=${pat#"${pat%%[![:space:]]*}"}          # ltrim
    [ -n "$pat" ] || continue
    if printf '%s' "$text" | grep -qiE -- "$pat" 2>/dev/null; then
      case " $out " in
        *" $type "*) : ;;                       # already have it
        *) out="${out:+$out }$type" ;;
      esac
    fi
  done < "$MMT_TAGS"
  printf '%s' "$out"
}

# Standalone mode for quick inspection.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _task="${1:-}"
  if [ -z "$_task" ] && [ ! -t 0 ]; then _task="$(cat)"; fi
  printf 'chars=%s\n' "$(mmt_char_count "$_task")"
  printf 'types=%s\n' "$(mmt_classify "$_task")"
fi
