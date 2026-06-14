#!/usr/bin/env python3
"""config.py — emit roster.json values as a bash-sourceable snippet.

Usage:
    config.py <roster.json> defaults-env          # defaults.* (fallback / quota / preset)
    config.py <roster.json> backend-env <name>    # backends.<name>.* as MMT_BE_* (+ enabled/kind)
    config.py <roster.json> proactive-env         # proactive.* as MMT_PROACTIVE_*

Scalars become  KEY='value'  and arrays become  KEY=( 'a' 'b' )  with safe quoting,
so run.sh / backends.sh / the hooks can `eval "$(config.py roster.json <mode>)"` and read
config without a parser. Array element values are kept literal (single-quoted); any '$VAR'
inside bin_candidates is substituted by bash later, on purpose. JSON only (no TOML / tomllib),
so any python3 works.
"""
import json
import shlex
import sys


def emit_scalar(name, value):
    print(f"{name}={shlex.quote(str(value))}")


def emit_array(name, values):
    quoted = " ".join(shlex.quote(str(v)) for v in (values or []))
    print(f"{name}=( {quoted} )")


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def emit_defaults_env(cfg, _name=None):
    d = cfg.get("defaults", {})
    emit_scalar("MMT_DEFAULT_FALLBACK", d.get("fallback", "native:sonnet"))
    emit_array("MMT_QUOTA_FALLBACK", d.get("quota_fallback", ["agy", "native:sonnet"]))
    emit_scalar("MMT_DEFAULT_PRESET", d.get("preset", "balanced"))


def emit_backend_env(cfg, name=None):
    backends = cfg.get("backends", {})
    be = backends.get(name, {}) if name else {}
    # A missing/unknown backend emits enabled=0 so run.sh skips it (falls through).
    emit_scalar("MMT_BE_NAME", name or "")
    emit_scalar("MMT_BE_ENABLED", "1" if be.get("enabled", False) else "0")
    emit_scalar("MMT_BE_KIND", be.get("kind", ""))
    emit_scalar("MMT_BE_CMD", be.get("cmd", name or ""))
    emit_scalar("MMT_BE_ONESHOT", be.get("oneshot_flag", "--print"))
    emit_scalar("MMT_BE_MODEL_FLAG", be.get("model_flag", "--model"))
    emit_array("MMT_BE_EXTRA", be.get("extra", []))
    models = be.get("models", {})
    emit_scalar("MMT_BE_MODEL_CHEAP", models.get("cheap", ""))
    emit_scalar("MMT_BE_MODEL_STANDARD", models.get("standard", ""))
    emit_scalar("MMT_BE_HEALTH", be.get("health", "--version"))
    emit_scalar("MMT_BE_ADD_DIR_FLAG", be.get("add_dir_flag", "--add-dir"))
    emit_scalar("MMT_BE_SANDBOX_FLAG", be.get("sandbox_flag", "--sandbox"))
    emit_scalar("MMT_BE_USE_WINPTY", "1" if be.get("use_winpty", True) else "0")
    emit_array("MMT_BE_WINPTY_FLAGS", be.get("winpty_flags", ["-Xallow-non-tty", "-Xplain"]))
    emit_array("MMT_BE_BIN_CANDIDATES", be.get("bin_candidates", []))
    emit_scalar("MMT_BE_HARD_TIMEOUT", be.get("hard_timeout", "6m"))
    emit_array("MMT_BE_QUOTA_PATTERNS", be.get("quota_patterns", []))
    emit_array("MMT_BE_QUOTA_EXIT_CODES", [str(c) for c in be.get("quota_exit_codes", [])])


def emit_proactive_env(cfg, _name=None):
    p = cfg.get("proactive", {})
    emit_scalar("MMT_PROACTIVE_ENABLED", "1" if p.get("enabled", False) else "0")
    emit_scalar("MMT_PROACTIVE_MAX_CHARS", str(_int(p.get("max_chars", 0))))
    emit_scalar("MMT_PROACTIVE_MIN_CHARS", str(_int(p.get("min_chars", 0))))
    emit_scalar("MMT_PROACTIVE_RULES", p.get("rules", "") or "")


MODES = {
    "defaults-env": emit_defaults_env,
    "backend-env": emit_backend_env,
    "proactive-env": emit_proactive_env,
}


def main():
    if len(sys.argv) < 3 or sys.argv[2] not in MODES:
        sys.stderr.write("usage: config.py <roster.json> {defaults-env|backend-env <name>|proactive-env}\n")
        return 2
    name = sys.argv[3] if len(sys.argv) >= 4 else None
    try:
        with open(sys.argv[1], encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"config.py: cannot read config: {e}\n")
        return 1
    MODES[sys.argv[2]](cfg, name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
