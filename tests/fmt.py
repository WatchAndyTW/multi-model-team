#!/usr/bin/env python3
# Compact one-line formatter for a route.sh decision (test helper).
import sys, json
d = json.load(sys.stdin)
print(f"{d['backend']:7} {d['tier']:8} {d['rule']:18} types={d['score']['types']}")
