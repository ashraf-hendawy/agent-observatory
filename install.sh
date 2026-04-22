#!/usr/bin/env bash
# Agent Observatory — Install Script
#
# Usage:
#   bash install.sh
#
# What this does:
#   1. Installs Python dependencies
#   2. Copies hook.py to ~/.claude/
#   3. Prints the settings.json snippet to add

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_DEST="$HOME/.claude/agent-observer-hook.py"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Agent Observatory — Installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Install dependencies
echo "▸ Installing Python dependencies..."
pip install -r "$SCRIPT_DIR/requirements.txt" --quiet
echo "  Done."

# Copy hook script
echo "▸ Copying hook to $HOOK_DEST..."
cp "$SCRIPT_DIR/hook.py" "$HOOK_DEST"
chmod +x "$HOOK_DEST"
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
    "PreToolUse": [
      {
        "matcher": "Agent",
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
        "matcher": "Agent",
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
echo "  python server.py"
echo ""
echo "  Then open:  http://localhost:8765"
echo ""
echo "  To use a different port:  python server.py --port 9000"
echo "  To expose on the network: python server.py --host 0.0.0.0"
echo ""
echo "  Set AGENT_OBSERVER_URL env var if the server runs on a non-default address:"
echo "    export AGENT_OBSERVER_URL=http://your-host:8765"
echo ""
