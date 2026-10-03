#!/usr/bin/env python3
"""Claude Code status line (macOS / Linux): repo/branch, git diff, context window, 5h + weekly limits."""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

E = "\033"
RESET, DIM = f"{E}[0m", f"{E}[2m"
GREEN, RED, YELLOW, BLUE, CYAN = (f"{E}[3{n}m" for n in (2, 1, 3, 4, 6))

sys.stdout.reconfigure(encoding="utf-8")
raw = sys.stdin.buffer.read().decode("utf-8-sig", errors="replace")
try:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "statusline-last.json"), "w", encoding="utf-8") as f:
        f.write(raw)
except OSError:
    pass
d = json.loads(raw or "{}")


def bar(left, color):
    n = round(max(0, min(100, left)) / 100 * 10)
    if left < 20:
        color = RED
    elif left < 50:
        color = YELLOW
    return color + "█" * n + DIM + "░" * (10 - n) + RESET


def reset_in(ts):
    if ts is None:
        return ""
    try:
        t = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() if isinstance(ts, str) else float(ts)
    except ValueError:
        return ""
    s = t - time.time()
    if s <= 0:
        return ""
    h, m = int(s // 3600), int(s % 3600 // 60)
    return f" {DIM}reset {h // 24}d {h % 24}h{RESET}" if h >= 24 else f" {DIM}reset {h}h {m}m{RESET}"


def git(*args, cwd):
    try:
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


parts = []
cwd = (d.get("workspace") or {}).get("current_dir") or d.get("cwd") or os.getcwd()
seg = f"{CYAN}{os.path.basename(cwd.rstrip('/'))}{RESET}"
branch = git("branch", "--show-current", cwd=cwd)
if branch:
    seg += f" {DIM}{branch}{RESET}"
    stat = git("diff", "HEAD", "--shortstat", cwd=cwd)
    add = int((re.search(r"(\d+) insertion", stat) or [0, 0])[1])
    dele = int((re.search(r"(\d+) deletion", stat) or [0, 0])[1])
    if add or dele:
        seg += f" {GREEN}+{add:,}{RESET} {RED}-{dele:,}{RESET}"
parts.append(seg)

name = (d.get("model") or {}).get("display_name")
if name:
    parts.append(f"{DIM}{name}{RESET}")

cw = d.get("context_window") or {}
left = cw.get("remaining_percentage")
if left is None and cw.get("used_percentage") is not None:
    left = 100 - cw["used_percentage"]
if left is not None:
    txt = f"ctx {bar(left, BLUE)} {round(left)}% left"
    if cw.get("context_window_size"):
        txt += f" {DIM}({round(cw['context_window_size'] * left / 100 / 1000)}k){RESET}"
    parts.append(txt)

rl = d.get("rate_limits") or {}
for key, label in (("five_hour", "5h"), ("seven_day", "week")):
    r = rl.get(key) or {}
    if r.get("used_percentage") is not None:
        lft = 100 - r["used_percentage"]
        parts.append(f"{label} {bar(lft, GREEN)} {round(lft)}% left{reset_in(r.get('resets_at'))}")

print(f" {DIM}|{RESET} ".join(parts))
