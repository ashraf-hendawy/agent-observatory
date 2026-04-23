#!/usr/bin/env bash
# Agent Observatory — Install Script
#
# Usage:
#   bash install.sh
#
# What this does:
#   1. Creates a Python virtual environment (.venv)
#   2. Installs dependencies into it
#   3. Copies hook.py to ~/.claude/
#   4. Prints the settings.json snippet to add

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_DEST="$HOME/.claude/agent-observer-hook.py"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Agent Observatory — Installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Require Python 3.9+
PYTHON=$(command -v python3 || true)
if [[ -z "$PYTHON" ]]; then
  echo "✗  python3 not found. Install Python 3.9+ and try again."
  exit 1
fi

PY_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$("$PYTHON" -c "import sys; print(sys.version_info.major)")
PY_MINOR=$("$PYTHON" -c "import sys; print(sys.version_info.minor)")
if [[ "$PY_MAJOR" -lt 3 ]] || { [[ "$PY_MAJOR" -eq 3 ]] && [[ "$PY_MINOR" -lt 9 ]]; }; then
  echo "✗  Python 3.9+ required (found $PY_VERSION). Please upgrade."
  exit 1
fi
echo "▸ Python $PY_VERSION — OK"

# Create virtual environment (only if it doesn't exist yet)
if [[ ! -d "$SCRIPT_DIR/.venv" ]]; then
  echo "▸ Creating virtual environment..."
  "$PYTHON" -m venv "$SCRIPT_DIR/.venv"
  echo "  Done."
else
  echo "▸ Virtual environment already exists."
fi

# Always install/upgrade dependencies so re-running picks up requirement changes
echo "▸ Installing Python dependencies..."
"$SCRIPT_DIR/.venv/bin/pip" install --upgrade -r "$SCRIPT_DIR/requirements.txt" --quiet
echo "  Done."

# Copy hook script (hook.py uses only stdlib — no venv needed to run it)
echo "▸ Copying hook to $HOOK_DEST..."
mkdir -p "$HOME/.claude"
cp "$SCRIPT_DIR/hook.py" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
if [[ ! -f "$HOOK_DEST" ]]; then
  echo "✗  Failed to copy hook to $HOOK_DEST — check permissions."
  exit 1
fi
echo "  Done."

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NEXT STEP: Add hooks to your Claude Code settings"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Add the following to ~/.claude/settings.json"
echo "(or to your project's .claude/settings.json for project-scoped capture):"
echo ""
cat << EOF
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 $HOOK_DEST session"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 $HOOK_DEST pre"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "python3 $HOOK_DEST post"
          }
        ]
      }
    ]
  }
}
EOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  START THE SERVER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  cd $SCRIPT_DIR"
echo "  .venv/bin/python server.py"
echo ""
echo "  Then open:  http://localhost:8765"
echo ""
echo "  Options:"
echo "    .venv/bin/python server.py --port 9000        # custom port"
echo "    .venv/bin/python server.py --host 0.0.0.0     # expose on network"
echo ""
echo "  Set AGENT_OBSERVER_URL if the server is not on localhost:"
echo "    export AGENT_OBSERVER_URL=http://your-host:8765"
echo ""
