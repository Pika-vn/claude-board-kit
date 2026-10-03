#!/usr/bin/env bash
# Installs the Claude Code usage board and status line on macOS / Linux.
#   bash install.sh             # full install
#   bash install.sh --skip-tools
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

# A tool counts as installed only if it actually runs: on a Mac without the Command Line Tools,
# /usr/bin/git and /usr/bin/python3 are stubs that just pop up an install dialog.
works() {
  case "$1" in
    python3) python3 -c 'import sys' >/dev/null 2>&1 ;;
    *) "$1" --version >/dev/null 2>&1 ;;
  esac
}

# 1. Tools: git (repo row), python3 (status line + settings merge), gh (clone this kit from GitHub)
if [[ "${1:-}" != "--skip-tools" ]]; then
  if [[ "$(uname)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
    step "Installing the Xcode Command Line Tools (gives git and python3)"
    xcode-select --install || true
    echo "Finish the installer window that opened, then run this script again." >&2
    exit 1
  fi
  for tool in git python3 gh; do
    if works "$tool"; then
      step "$tool already installed"
    elif command -v brew >/dev/null 2>&1; then
      step "Installing $tool with Homebrew"
      if [[ "$tool" == "python3" ]]; then brew install python; else brew install "$tool"; fi
    elif [[ "$tool" == "gh" ]]; then
      echo "note: gh not found; it is only needed to clone this kit from GitHub (https://brew.sh then: brew install gh)" >&2
    else
      echo "error: $tool is missing; install it, then run this script again" >&2
      exit 1
    fi
  done
fi
works python3 || { echo "error: python3 is required" >&2; exit 1; }

# 2. Copy the mod and the status line script
MOD="$CLAUDE_DIR/mods/plan-progress-plus"
step "Copying the progress board to $MOD"
for part in .claude-plugin/plugin.json hooks/hooks.json hooks/register.tsx types/index.d.ts \
            skills/plan-progress-plus/SKILL.md sounds/decision.wav sounds/error.wav sounds/done.wav LICENSE README.md; do
  mkdir -p "$(dirname "$MOD/$part")"
  cp "$KIT/plan-progress-plus/$part" "$MOD/$part"
done
cp "$KIT/statusline/statusline.py" "$CLAUDE_DIR/statusline.py"
chmod +x "$CLAUDE_DIR/statusline.py"

# 3. Merge settings.json (backup first, keep everything already there)
SETTINGS="$CLAUDE_DIR/settings.json"
[[ -f "$SETTINGS" ]] && cp "$SETTINGS" "$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
step "Updating $SETTINGS"
python3 - "$SETTINGS" "$MOD" "$CLAUDE_DIR/statusline.py" <<'PY'
import json, os, sys
path, mod, status = sys.argv[1:4]
s = json.load(open(path)) if os.path.exists(path) else {}
env = s.setdefault("env", {})
# drop earlier copies: the old usage-board and any other plan-progress-plus folder
dirs = [p for p in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(os.pathsep)
        if p and not p.rstrip("/").endswith(("usage-board", "plan-progress-plus"))]
env["CLAUDE_CODE_PLUGIN_DIRS"] = os.pathsep.join(dirs + [mod])
env["CLAUDE_CODE_PLUGIN_DIR_WATCH"] = "1"
# the original plan-progress would draw a second set of bars
if "plan-progress@zycck-mods" in s.get("enabledPlugins", {}):
    s["enabledPlugins"]["plan-progress@zycck-mods"] = False
s["statusLine"] = {"type": "command", "command": f'python3 "{status}"', "padding": 0}
json.dump(s, open(path, "w"), indent=2)
PY

echo
printf '\033[32mDone. Open a new Claude Code session to see the board.\033[0m\n'
