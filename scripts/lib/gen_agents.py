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
    forced = spec.get("dispatch") == "forced"
    dispatch = _dispatch_block(name, spec)

    # The intro / handoff line / hard rules are DISPATCH-AWARE. A `forced` agent embodies the
    # orchestrator's EXPLICIT backend choice — spawning it IS the decision — so it must HONOR that
    # backend and never self-reject or re-route on content (the bug we're fixing: an agent bouncing
    # an RE task back to native even though Claude deliberately picked it). The OPUS hard line stays
    # the AUTO-ROUTE default (route.sh) for the `route` mode and uncertain in-session decisions.
    if forced:
        intro = (
            f"You are the **{name}** dispatcher for the multi-model-team plugin. You do **not** solve "
            f"tasks yourself — you relay every task to the **{backend}** backend (**{tier}** tier) "
            f"through the plugin's scripts and return the result verbatim. This backend is the "
            f"orchestrator's **explicit choice** (spawning you *is* the decision): you run the task "
            f"there and do **not** re-route, downgrade, or refuse it based on the task's content."
        )
        handoff = (
            f"If stdout begins with `MMT_NATIVE_HANDOFF`, the **{backend}** CLI was "
            f"unavailable/exhausted (it fell through the fallback chain) — return that sentinel "
            f"verbatim so the orchestrator (Opus/Sonnet) handles it in-context."
        )
        rules = (
            f"- The orchestrator chose **{backend}** on purpose. Run the task as dispatched — do "
            f"**NOT** self-reject or re-route based on content (no \"this looks like RE, I'll bounce "
            f"it\"). CLI backends are weaker on reverse-engineering / systems-hard work, but that "
            f"trade-off is the caller's call, not yours.\n"
            f"- Do not edit files or run anything except the plugin scripts above. You are a relay."
        )
    else:
        intro = (
            f"You are the **{name}** dispatcher for the multi-model-team plugin. You do **not** solve "
            f"tasks yourself — you relay them through the plugin's scripts and return the result "
            f"verbatim. The **router** decides where work goes (it may keep hard/systems work native); "
            f"you never force an offload beyond what it picks."
        )
        handoff = (
            "If stdout begins with `MMT_NATIVE_HANDOFF`, the router chose native Claude (or the "
            "backend was unavailable/exhausted) — return that sentinel verbatim so the orchestrator "
            "(Opus/Sonnet) handles it in-context."
        )
        rules = (
            "- Let the router decide: do not force a backend it didn't pick.\n"
            "- Do not edit files or run anything except the plugin scripts above. You are a relay."
        )

    return f"""---
name: {name}
description: >-
{_wrap_description(role)}
tools: Bash
model: {model}
color: {color}
---

{GEN_NOTE}

{intro}

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
   - {handoff}
   - Otherwise stdout **is** the delegated result. Return it **verbatim** — no analysis, no
     reformatting, no preamble.
   - On a nonzero exit with no usable output, return stderr verbatim and stop.

## Hard rules

{rules}
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
