#!/usr/bin/env python3
"""team_spec.py — parse a /team agent-cap spec into per-backend caps.

Two modes:
  team_spec.py "5:gemini,2:claude"   # parse a pure spec string
  team_spec.py --split [text]        # deterministically peel a LEADING cap spec off
                                     # the front of <text> (or stdin) and also return
                                     # the task remainder, so the caller never guesses
                                     # where the spec ends and the task begins.

The spec is a comma list of `N:backend` (or `backend:N`) pairs. Backend names are
normalized: gemini/agy/flash/pro/google -> "gemini" (the agy CLI), and
claude/native/sonnet/opus/anthropic -> "claude" (native Claude). Order-agnostic and
case-insensitive. Lenient: an unparseable spec falls back to defaults with a note on
stderr rather than failing the command.

Caps are MAX parallel agents of each kind. "gemini" caps agy delegations; "claude" caps
spawned native subagents. Native work that exceeds the claude cap is still safe — the
orchestrating Claude handles it in-context (the hard line is never crossed for cost).

Emits one JSON line: {"gemini":N,"claude":M,"total":N+M,"source":"spec|default","note":"...",
                      "task":"<remainder>"}   (task only in --split mode)
"""
import json
import os
import re
import sys

GEMINI_ALIASES = {"gemini", "agy", "flash", "pro", "google"}
CLAUDE_ALIASES = {"claude", "native", "sonnet", "opus", "anthropic"}


def _env_int(name, default):
    try:
        v = os.environ.get(name, "")
        return max(0, int(v)) if v.strip() else default
    except (TypeError, ValueError):
        return default


DEFAULT_GEMINI = _env_int("MMT_TEAM_GEMINI_DEFAULT", 4)
DEFAULT_CLAUDE = _env_int("MMT_TEAM_CLAUDE_DEFAULT", 2)
MAX_PER_BACKEND = 16   # concurrency ceiling; keep runaways bounded


def _clamp(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return 0
    return max(0, min(MAX_PER_BACKEND, n))


def _normalize(name):
    name = name.strip().lower()
    if name in GEMINI_ALIASES:
        return "gemini"
    if name in CLAUDE_ALIASES:
        return "claude"
    return None


def parse(spec):
    spec = (spec or "").strip()
    if not spec:
        return {"gemini": DEFAULT_GEMINI, "claude": DEFAULT_CLAUDE,
                "total": DEFAULT_GEMINI + DEFAULT_CLAUDE, "source": "default", "note": ""}

    caps = {}
    notes = []
    for raw in spec.split(","):
        pair = raw.strip()
        if not pair:
            continue
        parts = [p.strip() for p in pair.split(":") if p.strip()]
        if len(parts) < 2:
            notes.append(f"ignored malformed pair '{pair}'")
            continue
        # Lenient: find one ASCII-number part and one known-backend part (handles 2- and
        # 3-part tokens like "5:gemini:standard").
        nums = [p for p in parts if re.fullmatch(r"\d+", p, re.ASCII)]
        names = [p for p in parts if _normalize(p) is not None]
        if not nums or not names:
            notes.append(f"ignored unparseable pair '{pair}'")
            continue
        if len(parts) > 2:
            notes.append(f"used {nums[0]}:{names[0]} from '{pair}'")
        caps[_normalize(names[0])] = caps.get(_normalize(names[0]), 0) + _clamp(nums[0])

    if not caps:
        return {"gemini": DEFAULT_GEMINI, "claude": DEFAULT_CLAUDE,
                "total": DEFAULT_GEMINI + DEFAULT_CLAUDE, "source": "default",
                "note": "; ".join(notes) or "no usable pairs in spec"}

    gemini = _clamp(caps.get("gemini", 0))
    claude = _clamp(caps.get("claude", 0))
    return {"gemini": gemini, "claude": claude, "total": gemini + claude,
            "source": "spec", "note": "; ".join(notes)}


def split(text):
    """Peel a LEADING cap spec off the front of <text>. Returns (spec, task).

    A leading token is treated as the spec ONLY if it is a comma list of `N:backend`
    pairs whose backend is a KNOWN alias, followed by whitespace then the task (or the
    whole string is the spec). Anything else -> ("", whole text). Deterministic, so the
    caller never has to guess the boundary (e.g. a task starting with "3 things: ..." is
    NOT misread as a spec).
    """
    text = text or ""
    backends = "|".join(re.escape(b) for b in sorted(GEMINI_ALIASES | CLAUDE_ALIASES, key=len, reverse=True))
    pair = rf"(?:\d+\s*:\s*(?:{backends})|(?:{backends})\s*:\s*\d+)"
    spec_re = rf"(?:{pair})(?:\s*,\s*(?:{pair}))*"
    m = re.match(rf"^\s*({spec_re})\s+(.*)$", text, re.IGNORECASE | re.DOTALL)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m = re.match(rf"^\s*({spec_re})\s*$", text, re.IGNORECASE)
    if m:
        return m.group(1).strip(), ""
    return "", text.strip()


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--split":
        rest = argv[1:]
        if rest and rest[0]:
            text = rest[0]
        elif not sys.stdin.isatty():
            text = sys.stdin.read()
        else:
            text = ""
        spec, task = split(text)
        result = parse(spec)
        result["task"] = task
    else:
        result = parse(argv[0] if argv else "")
    if result.get("note"):
        sys.stderr.write(f"team_spec: {result['note']}\n")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
