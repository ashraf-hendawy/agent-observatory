#!/usr/bin/env python3
"""
Agent Observatory — Claude Code Hook Script

Receives tool-use events from Claude Code via stdin and forwards them
to the Observatory server. Designed to be silent on any failure so it
never blocks Claude Code.

Configuration in settings.json:
    {
        "hooks": {
            "PreToolUse": [{
                "matcher": "Agent",
                "hooks": [{"type": "command", "command": "python3 /path/to/hook.py pre"}]
            }],
            "PostToolUse": [{
                "matcher": "Agent",
                "hooks": [{"type": "command", "command": "python3 /path/to/hook.py post"}]
            }]
        }
    }

Environment variables:
    AGENT_OBSERVER_URL   Base URL of the Observatory server (default: http://localhost:8765)
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request


def main() -> None:
    event_type = sys.argv[1] if len(sys.argv) > 1 else "unknown"

    try:
        raw = sys.stdin.read()
        data: dict = json.loads(raw)
    except Exception:
        sys.exit(0)

    # --- Normalise field names ---
    # Claude Code may use either a flat schema or a nested tool_use/tool_result schema.
    # We handle both.

    tool_name = (
        data.get("tool_name")
        or (data.get("tool_use") or {}).get("name", "")
    )

    tool_input = (
        data.get("tool_input")
        or (data.get("tool_use") or {}).get("input")
        or {}
    )

    raw_response = data.get("tool_response") or data.get("tool_result")
    if isinstance(raw_response, dict):
        # Extract content from {type: tool_result, content: [...]} shape
        raw_response = raw_response.get("content") or raw_response.get("text") or ""

    # --- Build payload ---
    payload = {
        "event": event_type,
        "session_id": data.get("session_id") or "unknown",
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_response": raw_response,
        "timestamp": time.time(),
    }

    server_url = os.environ.get("AGENT_OBSERVER_URL", "http://localhost:8765")
    body = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        f"{server_url}/events",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        urllib.request.urlopen(req, timeout=2)
    except (urllib.error.URLError, OSError, Exception):
        # Server is down or unreachable — never block Claude Code
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
