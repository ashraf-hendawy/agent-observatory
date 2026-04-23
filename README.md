# Agent Observatory

A real-time observability and communication tool for Claude Code multi-agent workflows.
Visualises agent call trees, timelines, flow graphs, and conversation logs as they happen — no code changes required.

![Python](https://img.shields.io/badge/Python-3.9%2B-00ff88?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-bf5af2?style=flat-square)

---

## What it does

The Observatory captures every Claude Code session and streams all activity to a live web UI — no code changes required. It tracks two kinds of events:

- **Agent spawns** — every `Agent` tool call appears as a full-size node with prompt, response, cost, and duration
- **Tool calls** — every `Bash`, `Read`, `Write`, `Grep`, `Glob`, `WebFetch`, etc. appears as a smaller activity node nested under the agent that called it

Sessions appear in the sidebar the moment Claude starts (via the `SessionStart` hook), before any tool is used.

Five views:

| View | What it shows |
|---|---|
| **Call Tree** | Hierarchical D3 graph. Agent nodes (large, glowing) and tool activity nodes (small pill, color-coded by type). Session root always visible. |
| **Timeline** | Gantt chart with real wall-clock times. Agent bars full-height, tool bars at 55% height. Depth-indented by nesting level. |
| **Flow** | Interconnection graph showing spawn edges (solid) and context-flow edges (dashed) between waves of agents. |
| **Logs** | CLI-style terminal. Agent entries show full prompt/response. Tool entries show compact input/output with a colored badge. |
| **Chat** | Agent-to-agent conversation board. Agents post to named boards via REST; messages appear live via SSE. |

**Stats bar** shows total agents, running, completed, interrupted, wall time, estimated token count, and estimated cost — all updating in real time.

---

## How it works

```
Claude Code session starts
      │  SessionStart hook
      ▼
   hook.py  ──── POST /session ───▶  server.py (FastAPI + SQLite)
      │                                      │
      │  PreToolUse / PostToolUse            │  SSE stream
      │  (all tools via ".*" matcher)        ▼
      └───────── POST /events ──────▶  Browser (D3.js)
```

`hook.py` uses only Python stdlib — no dependencies for the hook itself. Three hook events drive the Observatory:

| Hook | Trigger | Action |
|---|---|---|
| `SessionStart` | Claude starts | Registers the session immediately in the sidebar |
| `PreToolUse` (`.*`) | Any tool begins | Creates a running trace (agent or tool activity) |
| `PostToolUse` (`.*`) | Any tool finishes | Closes the trace with duration, response, and cost estimate |

Subagent sessions (spawned via the `Agent` tool) are detected by their `transcript_path` and filtered from the sidebar — only root sessions appear. All their tool activity is tracked under the correct parent trace.

The server persists all data to SQLite so sessions survive restarts.

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
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/agent-observer-hook.py session"
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
            "command": "python3 ~/.claude/agent-observer-hook.py pre"
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
            "command": "python3 ~/.claude/agent-observer-hook.py post"
          }
        ]
      }
    ]
  }
}
```

> If you already have hooks configured, merge the arrays — don't replace them.

The `".*"` matcher captures all tools. The hook internally routes Agent tool events as agent traces and everything else as tool activity nodes.

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

## Icons

**Agent nodes** use emojis matched by agent type name:

| Agent type | Icon |
|---|---|
| `architecture-reviewer` | 🏗️ |
| `senior-engineer` | 🧑‍💻 |
| `team-lead` | 👑 |
| `adr-writer` / `plan` | 📋 / 🗺️ |
| `cross-team-scanner` | 🔭 |
| `explore` | 🧭 |
| `general-purpose` / `claude` | 🤖 |
| `reviewer` | 🔍 |
| Unnamed (funny name) | Species emoji 🐡 🦝 🐧 … |
| Session root | 🚀 |

To add an icon for your own agent types, edit `NAMED_ICONS` in `static/app.js`.

**Tool activity nodes** are color-coded by tool type:

| Tool | Icon | Color |
|---|---|---|
| `Bash` | ⚡ | Amber |
| `Read` | 📖 | Cyan |
| `Write` / `Edit` | 📝 / ✏️ | Green |
| `Grep` / `Glob` | 🔍 / 🗂️ | Purple |
| `WebFetch` / `WebSearch` | 🌐 / 🔎 | Red |
| `TodoWrite` / `TodoRead` | ✅ / 📋 | Cyan |

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
| `POST` | `/session` | Register a session (called by SessionStart hook) |
| `POST` | `/events` | Receive a tool hook event (`pre` or `post`) |
| `GET` | `/sessions` | List root sessions with aggregate stats (subagents excluded) |
| `GET` | `/sessions/{id}/traces` | All traces for a session (agents + tool activities) |
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
[['my-agent-name'], '🛠️'],
```

**New tool color** — add an entry to `TOOL_COLORS` and `TOOL_ICONS` in `static/app.js`:
```js
const TOOL_ICONS  = { ..., MyTool: '🔬' };
const TOOL_COLORS = { ..., MyTool: '#00d4ff' };
```

**Custom event sources** — any system that can POST to `/events` with the payload above will appear in the UI. Instrument your own agent frameworks or CI pipelines.

**Persistent shared instance** — run the server behind nginx. SQLite WAL mode handles concurrent writes safely for small teams.

---

## License

MIT
