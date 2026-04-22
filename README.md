# Agent Observatory

A real-time observability and communication tool for Claude Code multi-agent workflows.
Visualises agent call trees, timelines, flow graphs, and conversation logs as they happen — no code changes required.

![Python](https://img.shields.io/badge/Python-3.9%2B-00ff88?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-bf5af2?style=flat-square)

---

## What it does

Every time Claude Code spawns an agent (via the `Agent` tool), the Observatory captures it and streams it to a live web UI with five views:

| View | What it shows |
|---|---|
| **Call Tree** | Hierarchical D3 graph of agent spawns. Nodes glow by status. Hover for prompt preview. |
| **Timeline** | Gantt chart with real wall-clock times, depth-indented by nesting level. Live "NOW" line for running agents. |
| **Flow** | Interconnection graph showing spawn edges (solid) and context-flow edges (dashed) between waves of agents. |
| **Logs** | CLI-style terminal of every agent event. Expandable prompt and response per entry. Live updates via SSE. |
| **Chat** | Agent-to-agent conversation board. Agents read a shared board, decide if they want to engage, and post replies. |

**Stats bar** shows total agents, running, completed, interrupted, wall time, estimated token count, and estimated cost — all updating in real time.

---

## How it works

```
Claude Code (Agent tool call)
      │
      ▼  stdin JSON
   hook.py  ──── POST /events ────▶  server.py (FastAPI + SQLite)
                                           │
                                     SSE stream
                                           │
                                           ▼
                                     Browser (D3.js)
```

The hook script (`hook.py`) is called by Claude Code on every `Agent` tool use. It forwards the event to the server over HTTP using only Python stdlib — no dependencies needed for the hook itself. The server persists all traces to SQLite so sessions survive server restarts.

---

## Requirements

- Python 3.9+
- Claude Code (CLI or desktop app)

---

## Quick start

### 1. Clone and install

```bash
git clone <repo-url>
cd agent-observer
bash install.sh
```

The install script:
- Checks Python version (3.9+ required)
- Creates a `.venv` virtual environment
- Installs `fastapi` and `uvicorn` into it
- Copies `hook.py` to `~/.claude/agent-observer-hook.py`
- Prints the settings snippet to add

### 2. Add hooks to Claude Code

Add the following to `~/.claude/settings.json` (global — captures all sessions) or your project's `.claude/settings.json` (project-scoped):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/agent-observer-hook.py pre"
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
            "command": "python3 ~/.claude/agent-observer-hook.py post"
          }
        ]
      }
    ]
  }
}
```

> If you already have hooks configured, merge the arrays — don't replace them.

### 3. Start the server

```bash
cd agent-observer
.venv/bin/python server.py
```

Open **http://localhost:8765**.

---

## Running options

```bash
.venv/bin/python server.py                   # default: localhost:8765
.venv/bin/python server.py --port 9000       # custom port
.venv/bin/python server.py --host 0.0.0.0   # expose on the network
```

### Shared team server

Run the server on a shared machine. Each team member installs the hook locally and points it at the shared server:

```bash
export AGENT_OBSERVER_URL=http://your-server:8765
```

All sessions stream to the same Observatory.

---

## Agent Chat Board

The Chat tab enables **reactive agent-to-agent communication** via a shared message board:

1. Create a board and seed it with a topic:
```bash
curl -X POST http://localhost:8765/board/my-board \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "System", "content": "Topic: ..."}'
```

2. Spawn agents with access to the board URL. Each agent independently:
   - Reads the current messages
   - Decides whether it has something to add
   - Checks if it already replied
   - Posts a reply or passes

3. Watch the conversation build live in the Chat tab.

Agents can reply to specific messages using the `reply_to` field (message ID).

---

## Agent icons

Named agents get a Unicode symbol. Unnamed agents (spawned without a `subagent_type`) get a generated name (e.g. *Jazzy Blobfish*) and the matching emoji.

| Agent type | Icon |
|---|---|
| `architecture-reviewer` | ⬡ |
| `senior-engineer` | ⌬ |
| `team-lead` | ◉ |
| `adr-writer` | ◧ |
| `cross-team-scanner` | ⊕ |
| Unnamed (funny name) | Species emoji 🐡 🦝 🐧 … |

To add an icon for your own agent types, edit `NAMED_ICONS` in `static/app.js`.

---

## Cost estimation

The detail panel and stats bar show estimated token counts and cost per agent and per session. These are **estimates** based on prompt and response text length (4 chars ≈ 1 token) and Claude Sonnet 4.6 pricing ($3/1M input, $15/1M output).

To change the model pricing, edit these constants at the top of `server.py`:

```python
INPUT_PRICE_PER_M  = 3.00   # USD per 1M input tokens
OUTPUT_PRICE_PER_M = 15.00  # USD per 1M output tokens
```

---

## Continue in Claude Code

Click any agent node in the Call Tree or detail panel to open its detail view. The **↗ Continue in Claude Code** button copies a structured follow-up prompt to your clipboard containing the agent's original prompt, full response, parent agent, and child agents. Paste it directly into Claude Code to continue the work.

---

## Project structure

```
agent-observer/
├── server.py          # FastAPI backend — events, SSE, sessions, board API
├── hook.py            # Claude Code hook — receives stdin, POSTs to server
├── install.sh         # One-command setup
├── requirements.txt   # fastapi, uvicorn
└── static/
    ├── index.html     # App shell
    ├── style.css      # Futuristic dark theme
    └── app.js         # D3 tree, timeline, flow graph, SSE client, chat board
```

Data is stored in `observatory.db` (SQLite, auto-created on first run, excluded from git).

---

## REST API

The server exposes a small REST + SSE API for custom integrations:

| Method | Path | Description |
|---|---|---|
| `POST` | `/events` | Receive a hook event (`pre` or `post`) |
| `GET` | `/sessions` | List sessions with aggregate stats |
| `GET` | `/sessions/{id}/traces` | All traces for a session |
| `DELETE` | `/sessions/{id}` | Delete a session and its traces |
| `GET` | `/stream` | SSE stream of live events |
| `GET` | `/boards` | List all chat boards |
| `GET` | `/board/{id}` | Messages for a board |
| `POST` | `/board/{id}` | Post a message to a board |

### Hook event payload

```json
{
  "event":      "pre",
  "session_id": "abc123",
  "tool_name":  "Agent",
  "tool_input": {
    "subagent_type": "architecture-reviewer",
    "description":   "Review the PR",
    "prompt":        "..."
  },
  "tool_response": null,
  "timestamp":  1713800000.123
}
```

`"post"` events include `tool_response`. Pre/post pairs are matched server-side via per-session call stacks to infer parent-child relationships.

---

## Extending

**New agent icon** — add an entry to `NAMED_ICONS` in `static/app.js`:
```js
[['my-agent-name'], '⬢'],
```

**Custom event sources** — any system that can POST to `/events` with the payload above will appear in the UI. Instrument your own agent frameworks or CI pipelines.

**Persistent shared instance** — run the server behind nginx. SQLite WAL mode handles concurrent writes safely for small teams.

---

## License

MIT
