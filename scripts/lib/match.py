#!/usr/bin/env python3
"""match.py — apply roster.toml [[route]] rules to a scored task.

Usage:
    match.py <roster.toml> <chars> <types-csv> [preset]

<types-csv> is the comma-separated type list from score.sh (may be empty).
<preset>    overrides defaults.preset when given (balanced|budget|premium).

Emits one JSON line describing the routing decision. Always emits valid JSON and
exits 0 for routable input; on a config error it emits a safe Sonnet fallback
decision (rule="config-error") and a warning on stderr.
"""
import json
import sys


def load_toml(path):
    import tomllib
    with open(path, "rb") as f:
        return tomllib.load(f)


def resolve_model(cfg, backend, tier):
    """Map (backend, tier) -> a concrete model string + native flag."""
    if backend == "native":
        return f"native:{tier}", True
    be = cfg.get("backends", {}).get(backend, {})
    models = be.get("models", {})
    # agy exposes cheap/standard. Fall back to standard, then any available.
    if tier in models:
        return models[tier], False
    if "standard" in models:
        return models["standard"], False
    if models:
        return next(iter(models.values())), False
    return f"{backend}:{tier}", False


def apply_preset(preset, rule_name, backend, tier):
    """Documented preset biases (see roster.toml header)."""
    if preset == "budget" and rule_name == "judgment-coding":
        return "agy", "standard"
    if preset == "premium" and rule_name in ("standard-coding", "trivial"):
        return "native", "sonnet"
    return backend, tier


def match_rule(routes, chars, types):
    tset = set(t for t in types if t)
    for r in routes:
        when = r.get("when", {}) or {}
        # Empty when {} == catch-all.
        ok = True
        if "type" in when:
            if not (tset & set(when["type"])):
                ok = False
        if ok and "min_chars" in when:
            if chars < int(when["min_chars"]):
                ok = False
        if ok and "max_chars" in when:
            if chars > int(when["max_chars"]):
                ok = False
        if ok:
            return r
    return None


def main():
    argv = sys.argv[1:]
    if len(argv) < 3:
        print('{"error":"usage: match.py <roster.toml> <chars> <types-csv> [preset]"}')
        return 2

    roster_path = argv[0]
    try:
        chars = int(argv[1])
    except ValueError:
        chars = 0
    types = [t.strip() for t in argv[2].split(",") if t.strip()]
    preset_override = argv[3] if len(argv) >= 4 and argv[3] else None

    score = {"chars": chars, "types": types}

    try:
        cfg = load_toml(roster_path)
    except Exception as e:  # noqa: BLE001 - resilience: never hard-fail routing
        sys.stderr.write(f"match.py: config error: {e}\n")
        decision = {
            "backend": "native", "model": "native:sonnet", "tier": "sonnet",
            "rule": "config-error", "native": True,
            "preset": preset_override or "balanced", "score": score,
        }
        print(json.dumps(decision, ensure_ascii=False))
        return 0

    defaults = cfg.get("defaults", {})
    preset = preset_override or defaults.get("preset", "balanced")
    routes = cfg.get("route", [])

    rule = match_rule(routes, chars, types)
    if rule is None:
        # Should be impossible (catch-all-safe has when={}), but stay safe.
        backend, tier, rule_name = "native", "sonnet", "catch-all-safe"
    else:
        backend = rule.get("backend", "native")
        tier = rule.get("tier", "sonnet")
        rule_name = rule.get("name", "unnamed")

    backend, tier = apply_preset(preset, rule_name, backend, tier)
    model, native = resolve_model(cfg, backend, tier)

    decision = {
        "backend": backend, "model": model, "tier": tier,
        "rule": rule_name, "native": native, "preset": preset, "score": score,
    }
    print(json.dumps(decision, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
