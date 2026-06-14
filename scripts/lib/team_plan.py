#!/usr/bin/env python3
"""team_plan.py — expand a /team plan.json into per-subtask files + a manifest.

Usage:
    team_plan.py <plan.json> <workdir>

plan.json is a JSON array of subtasks:
  [{"label": "build-ui", "task": "<text>", "backend": "agy"|"codex"|"native", "tier": "standard"}]

For each subtask this writes the raw task text to <workdir>/<idx>.task (so the task is
NEVER passed through a shell — team.sh feeds the file to run.sh on stdin, injection-safe),
and prints one manifest line per subtask to stdout:

  <AGY|CODEX|NATIVE>\t<idx>\t<label>\t<tier>\t<workdir>/<idx>.task

backend is normalized: gemini/agy -> AGY; codex/chatgpt/openai -> CODEX; claude/native/sonnet/opus
-> NATIVE. Backends are equal — any CLI backend dispatches via run.sh; NATIVE is solved by Claude.
Entries missing a task are skipped (noted on stderr). Exit 0 unless the plan is unreadable.
"""
import json
import os
import re
import sys

AGY = {"agy", "gemini", "flash", "pro", "google"}
CODEX = {"codex", "chatgpt", "openai", "gpt"}
NATIVE = {"native", "claude", "sonnet", "opus", "anthropic"}
CLI_TIERS = {"cheap", "standard"}      # any CLI backend (agy, codex, ...)
NATIVE_TIERS = {"sonnet", "opus"}


def _tier(raw, backend):
    # Allowlist the tier per backend. This is also the security boundary: only these
    # fixed values reach the TAB/NEWLINE-delimited manifest, so a crafted tier with an
    # embedded \t/\n can never forge an extra manifest row (TSV injection).
    raw = str(raw or "").strip().lower()
    if backend == "NATIVE":
        return raw if raw in NATIVE_TIERS else "sonnet"
    return raw if raw in CLI_TIERS else "standard"


def _sanitize_label(label, idx):
    label = re.sub(r"[^A-Za-z0-9._-]+", "-", str(label or "").strip()).strip("-")
    return label[:48] or f"task{idx}"


def _backend(name):
    name = str(name or "").strip().lower()
    if name in AGY:
        return "AGY"
    if name in CODEX:
        return "CODEX"
    if name in NATIVE:
        return "NATIVE"
    return ""


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: team_plan.py <plan.json> <workdir>\n")
        return 2
    plan_path, workdir = sys.argv[1], sys.argv[2]
    try:
        with open(plan_path, encoding="utf-8") as f:
            plan = json.load(f)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"team_plan: cannot read plan: {e}\n")
        return 2
    if not isinstance(plan, list):
        sys.stderr.write("team_plan: plan must be a JSON array\n")
        return 2

    os.makedirs(workdir, exist_ok=True)
    out = []
    for idx, item in enumerate(plan):
        if not isinstance(item, dict):
            sys.stderr.write(f"team_plan: skip non-object entry #{idx}\n")
            continue
        task = item.get("task")
        if not task or not str(task).strip():
            sys.stderr.write(f"team_plan: skip entry #{idx} with empty task\n")
            continue
        backend = _backend(item.get("backend", "native"))
        if not backend:
            backend = "NATIVE"  # unknown -> safe default
        tier = _tier(item.get("tier"), backend)
        label = _sanitize_label(item.get("label", ""), idx)
        taskfile = os.path.join(workdir, f"{idx}.task")
        with open(taskfile, "w", encoding="utf-8", newline="\n") as tf:
            tf.write(str(task))
        out.append(f"{backend}\t{idx}\t{label}\t{tier}\t{taskfile}")

    sys.stdout.write("\n".join(out) + ("\n" if out else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
