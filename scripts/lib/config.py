#!/usr/bin/env python3
"""config.py — emit roster.toml values as a bash-sourceable snippet.

Usage:
    config.py <roster.toml> agy-env     # backends.agy + defaults as shell assignments

Scalars become  KEY='value'  and arrays become  KEY=( 'a' 'b' )  with safe quoting,
so backends.sh / run.sh can `eval "$(config.py roster.toml agy-env)"` and read config
without a TOML parser. Array element values are kept literal (single-quoted); any
'$VAR' inside bin_candidates is substituted by bash later, on purpose.
"""
import shlex
import sys


def emit_scalar(name, value):
    print(f"{name}={shlex.quote(str(value))}")


def emit_array(name, values):
    quoted = " ".join(shlex.quote(str(v)) for v in values)
    print(f"{name}=( {quoted} )")


def main():
    if len(sys.argv) < 3 or sys.argv[2] != "agy-env":
        sys.stderr.write("usage: config.py <roster.toml> agy-env\n")
        return 2
    import tomllib
    with open(sys.argv[1], "rb") as f:
        cfg = tomllib.load(f)

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
