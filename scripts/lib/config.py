#!/usr/bin/env python3
"""config.py — emit roster.toml values as a bash-sourceable snippet.

Usage:
    config.py <roster.toml> agy-env        # backends.agy + defaults as shell assignments
    config.py <roster.toml> proactive-env  # [proactive] hook config as shell assignments

Scalars become  KEY='value'  and arrays become  KEY=( 'a' 'b' )  with safe quoting,
so backends.sh / run.sh / the hooks can `eval "$(config.py roster.toml <mode>)"` and read
config without a TOML parser. Array element values are kept literal (single-quoted); any
'$VAR' inside bin_candidates is substituted by bash later, on purpose.
"""
import shlex
import sys


def emit_scalar(name, value):
    print(f"{name}={shlex.quote(str(value))}")


def emit_array(name, values):
    quoted = " ".join(shlex.quote(str(v)) for v in values)
    print(f"{name}=( {quoted} )")


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def emit_agy_env(cfg):
    defaults = cfg.get("defaults", {})
    agy = cfg.get("backends", {}).get("agy", {})
    models = agy.get("models", {})

    emit_scalar("MMT_DEFAULT_FALLBACK", defaults.get("fallback", "native:sonnet"))
    emit_array("MMT_QUOTA_FALLBACK", defaults.get("quota_fallback", ["agy", "native:sonnet"]))
    emit_scalar("MMT_DEFAULT_PRESET", defaults.get("preset", "balanced"))

    emit_scalar("MMT_AGY_CMD", agy.get("cmd", "agy"))
    emit_scalar("MMT_AGY_ONESHOT", agy.get("oneshot_flag", "--print"))
    emit_scalar("MMT_AGY_MODEL_FLAG", agy.get("model_flag", "--model"))
    emit_array("MMT_AGY_EXTRA", agy.get("extra", []))
    emit_scalar("MMT_AGY_MODEL_CHEAP", models.get("cheap", ""))
    emit_scalar("MMT_AGY_MODEL_STANDARD", models.get("standard", ""))
    emit_scalar("MMT_AGY_HEALTH", agy.get("health", "--version"))
    emit_scalar("MMT_AGY_ADD_DIR_FLAG", agy.get("add_dir_flag", "--add-dir"))
    emit_scalar("MMT_AGY_SANDBOX_FLAG", agy.get("sandbox_flag", "--sandbox"))
    emit_scalar("MMT_AGY_USE_WINPTY", "1" if agy.get("use_winpty", True) else "0")
    emit_array("MMT_AGY_WINPTY_FLAGS", agy.get("winpty_flags", ["-Xallow-non-tty", "-Xplain"]))
    emit_array("MMT_AGY_BIN_CANDIDATES", agy.get("bin_candidates", []))
    emit_scalar("MMT_AGY_HARD_TIMEOUT", agy.get("hard_timeout", "6m"))
    emit_array("MMT_AGY_QUOTA_PATTERNS", agy.get("quota_patterns", []))
    emit_array("MMT_AGY_QUOTA_EXIT_CODES", [str(c) for c in agy.get("quota_exit_codes", [])])


def emit_proactive_env(cfg):
    p = cfg.get("proactive", {})
    emit_scalar("MMT_PROACTIVE_ENABLED", "1" if p.get("enabled", False) else "0")
    emit_scalar("MMT_PROACTIVE_MAX_CHARS", str(_int(p.get("max_chars", 0))))
    emit_scalar("MMT_PROACTIVE_MIN_CHARS", str(_int(p.get("min_chars", 0))))
    emit_scalar("MMT_PROACTIVE_RULES", p.get("rules", "") or "")


MODES = {"agy-env": emit_agy_env, "proactive-env": emit_proactive_env}


def main():
    if len(sys.argv) < 3 or sys.argv[2] not in MODES:
        sys.stderr.write("usage: config.py <roster.toml> {agy-env|proactive-env}\n")
        return 2
    import tomllib
    with open(sys.argv[1], "rb") as f:
        cfg = tomllib.load(f)
    MODES[sys.argv[2]](cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
