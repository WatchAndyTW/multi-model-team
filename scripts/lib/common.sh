#!/usr/bin/env bash
# common.sh — small shared helpers.

# Locate a python3. Config is JSON now, so stdlib `json` is all we need (any python3).
# Honors $MMT_PYTHON.
mmt_find_python() {
  local cand
  for cand in "${MMT_PYTHON:-}" python3 python; do
    [ -n "$cand" ] || continue
    if command -v "$cand" >/dev/null 2>&1 && \
       "$cand" -c 'import json' >/dev/null 2>&1; then
      printf '%s' "$cand"; return 0
    fi
  done
  return 1
}
