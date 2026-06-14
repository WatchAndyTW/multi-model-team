#!/usr/bin/env python3
"""gen_agents.py — (re)generate agents/<name>.md from config/roster.json.

Usage:
    gen_agents.py [roster.json] [agents_dir]

For each entry under "agents": an ENABLED agent gets agents/<name>.md written (YAML
frontmatter from its role/model/color + a templated relay body keyed by backend/tier/
dispatch); a DISABLED agent has its agents/<name>.md removed so Claude Code won't surface
it. Defaults resolve to the repo layout relative to this file. Prints one line per action.

Edit the JSON (agents.<name>), then run this — never hand-edit the generated .md files.
"""
import json
import os
import sys
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

GEN_NOTE = (
    "<!-- GENERATED from config/roster.json by scripts/lib/gen_agents.py — edit the JSON\n"
    "     (agents.<name>), then re-run the generator. Do not hand-edit this file. -->"
)


def _wrap_description(role):
    # YAML folded block scalar: 2-space indented continuation lines.
    lines = textwrap.wrap(role, width=92) or [""]
    return "\n".join("  " + ln for ln in lines)


def _dispatch_block(name, spec):
    backend = spec.get("backend", "agy")
    tier = spec.get("tier", "standard")
    if spec.get("dispatch") == "forced":
        decision = (
            '{"backend":"%s","model":"","tier":"%s","rule":"%s-forced","native":false}'
            % (backend, tier, name)
        )
        return (
            'bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" \\\n'
            "     --decision '%s' \\\n"
            '     "<the full task text>"' % decision
        )
    return 'bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" "<the full task text>"'


def render(name, spec):
    backend = spec.get("backend", "agy")
    tier = spec.get("tier", "standard")
    model = spec.get("model", "haiku")
    color = spec.get("color", "blue")
    role = spec.get("role", "") or f"Delegation agent {name}."
    dispatch = _dispatch_block(name, spec)
    return f"""---
name: {name}
description: >-
{_wrap_description(role)}
tools: Bash
model: {model}
color: {color}
---

{GEN_NOTE}

You are the **{name}** dispatcher for the multi-model-team plugin. You do **not** solve tasks
yourself — you relay them to the **{backend}** backend (**{tier}** tier) through the plugin's
scripts and return the result verbatim. The router decides where work goes; you never force an
offload beyond your configured backend.

## What to do

1. Take the task text you were given.
2. Run the executor:

   ```bash
   {dispatch}
   ```

   - If the task references a local file/dir the backend should read itself, add
     `--add-dir "<dir>"` so the backend reads it on its own quota instead of through Claude.
   - Pass the task as a single quoted argument. Do not add commentary to the prompt.
3. Interpret the output:
   - If stdout begins with `MMT_NATIVE_HANDOFF`, the router chose native Claude (or the backend
     was unavailable/exhausted). Do **not** attempt the task — return that sentinel verbatim so
     the orchestrator (Opus/Sonnet) handles it in-context.
   - Otherwise stdout **is** the delegated result. Return it **verbatim** — no analysis, no
     reformatting, no preamble.
   - On a nonzero exit with no usable output, return stderr verbatim and stop.

## Hard rules

- Never reverse-engineer, disassemble, decompile, or touch binary/IL2CPP/protobuf-RE, FFI/unsafe,
  injection/hooking, shellcode, memory patching, concurrency, lock-free, protocol/KCP design, or
  proc-macros. If asked, return the `MMT_NATIVE_HANDOFF` sentinel — the router already routes those
  to Opus. Do not run them through a delegated backend.
- Do not edit files or run anything except the plugin scripts above. You are a relay.
"""


def main():
    roster = sys.argv[1] if len(sys.argv) >= 2 else os.path.join(ROOT, "config", "roster.json")
    agents_dir = sys.argv[2] if len(sys.argv) >= 3 else os.path.join(ROOT, "agents")
    try:
        with open(roster, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"gen_agents: cannot read {roster}: {e}\n")
        return 1

    agents = cfg.get("agents", {})
    os.makedirs(agents_dir, exist_ok=True)
    wrote = removed = 0
    for name, spec in agents.items():
        if not isinstance(spec, dict):  # skip _comment and any non-object
            continue
        path = os.path.join(agents_dir, f"{name}.md")
        if spec.get("enabled", False):
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(render(name, spec))
            wrote += 1
            print(f"wrote   {name}.md  (backend={spec.get('backend')}, tier={spec.get('tier')})")
        else:
            if os.path.exists(path):
                os.remove(path)
                removed += 1
                print(f"removed {name}.md  (disabled)")
            else:
                print(f"skip    {name}    (disabled, no file)")
    print(f"-- {wrote} written, {removed} removed --")
    return 0


if __name__ == "__main__":
    sys.exit(main())
