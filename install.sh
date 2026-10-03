#!/usr/bin/env bash
# Installs the Claude Code usage board and status line on macOS / Linux.
#   bash install.sh             # full install
#   bash install.sh --skip-tools
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

# 1. Tools: git (repo row), gh (Create PR), python3 (status line + settings merge)
if [[ "${1:-}" != "--skip-tools" ]]; then
  for tool in git gh python3; do
    if command -v "$tool" >/dev/null 2>&1; then
      step "$tool already installed"
    elif command -v brew >/dev/null 2>&1; then
      step "Installing $tool with Homebrew"
      brew install "$( [[ $tool == python3 ]] && echo python || echo "$tool" )"
    else
      echo "warning: install $tool by hand (no Homebrew found)" >&2
    fi
  done
fi

# 2. Copy the mod and the status line script
MOD="$CLAUDE_DIR/mods/usage-board"
step "Copying the usage board to $MOD"
for part in .claude-plugin/plugin.json hooks/hooks.json hooks/register.tsx types/index.d.ts; do
  mkdir -p "$(dirname "$MOD/$part")"
  cp "$KIT/usage-board/$part" "$MOD/$part"
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
dirs = [p for p in env.get("CLAUDE_CODE_PLUGIN_DIRS", "").split(os.pathsep) if p and not p.rstrip("/").endswith("usage-board")]
env["CLAUDE_CODE_PLUGIN_DIRS"] = os.pathsep.join(dirs + [mod])
env["CLAUDE_CODE_PLUGIN_DIR_WATCH"] = "1"
s["statusLine"] = {"type": "command", "command": f"python3 {status}", "padding": 0}
json.dump(s, open(path, "w"), indent=2)
PY

echo
printf '\033[32mDone. Open a new Claude Code session to see the board.\033[0m\n'
echo 'For the Create PR button, sign in to GitHub once:  gh auth login'
