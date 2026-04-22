# Agent Observatory

A real-time observability tool for Claude Code multi-agent workflows.
Visualises agent call trees, timelines, prompts, and responses as they happen — no code changes required.

![Agent Observatory](https://img.shields.io/badge/Claude_Code-Hooks-00d4ff?style=flat-square)
![Python](https://img.shields.io/badge/Python-3.9%2B-00ff88?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-bf5af2?style=flat-square)

---

## What it does

Every time Claude Code spawns an agent (via the `Agent` tool), the Observatory captures:

- **Who** — the agent type or a generated name for unnamed agents
- **What** — the full prompt and response
- **When** — exact start/end times and duration
- **How** — the parent/child call hierarchy across nested agent spawns

All of this is streamed live to a web UI with a call tree, Gantt timeline, and detail panel.

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
                               ┌────────────────────────┐
                               │  Call Tree │ Timeline   │
                               │  Detail Panel          │
                               └────────────────────────┘
```

The hook script (`hook.py`) is a lightweight Python file that receives tool-use events from Claude Code via stdin and forwards them to the server over HTTP. It uses only stdlib — no dependencies required for the hook itself.

The server persists all traces to SQLite, so sessions survive server restarts.

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
- Installs `fastapi` and `uvicorn` into a local `.venv`
- Copies `hook.py` to `~/.claude/agent-observer-hook.py`
- Prints the settings snippet to add

### 2. Add hooks to Claude Code

Add the following to your `~/.claude/settings.json` (global — captures all sessions) or to your project's `.claude/settings.json` (project-scoped):

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

> If you already have hooks configured, merge the `PreToolUse` and `PostToolUse` arrays — don't replace them.

### 3. Start the server

```bash
cd agent-observer
.venv/bin/python server.py
```

Then open **http://localhost:8765**.

---

## Running options

```bash
# Default (localhost:8765)
.venv/bin/python server.py

# Custom port
.venv/bin/python server.py --port 9000

# Expose on the network (share with your team)
.venv/bin/python server.py --host 0.0.0.0 --port 8765
```

### Shared team server

If you run the server on a shared machine, set the hook to point at it:

```bash
export AGENT_OBSERVER_URL=http://your-server:8765
```

Or set it permanently in your shell profile. Each team member installs the hook locally; all sessions stream to the shared Observatory.

---

## UI overview

| Panel | What it shows |
|---|---|
| **Sessions sidebar** | All captured Claude Code sessions, newest first. Health dots show running / interrupted agents. |
| **Call Tree** | D3 hierarchy of agent spawns. Nodes glow by status (amber = running, green = done, purple = interrupted). Hover for prompt preview. Click to inspect. |
| **Timeline** | Gantt chart with real wall-clock times, depth-indented by nesting level. A red "NOW" line tracks live agents. |
| **Stats bar** | Total agents · Running · Completed · Interrupted · Wall time — updates in real time via SSE. |
| **Detail panel** | Agent icon, full prompt + response, word counts, timing, parent agent, clickable child agents. |

---

## Agent icons

Named agents get a Unicode symbol; unnamed agents (spawned without a `subagent_type`) get a random funny name (e.g. *Jazzy Blobfish*) and the matching emoji.

| Agent type | Icon |
|---|---|
| `architecture-reviewer` | ⬡ |
| `senior-engineer` | ⌬ |
| `team-lead` | ◉ |
| `adr-writer` | ◧ |
| `cross-team-scanner` | ⊕ |
| `architecture-reviewer` | ◎ |
| Unnamed (funny name) | Species emoji (🐡 🦝 🐧 …) |

To add icons for your own custom agents, edit the `NAMED_ICONS` array in `static/app.js`.

---

## Project structure

```
agent-observer/
├── server.py          # FastAPI backend — events, SSE, sessions API
├── hook.py            # Claude Code hook — receives stdin, POSTs to server
├── install.sh         # One-command setup
├── requirements.txt   # fastapi, uvicorn
└── static/
    ├── index.html     # App shell
    ├── style.css      # Futuristic dark theme
    └── app.js         # D3 tree, timeline, SSE client, detail panel
```

Data is stored in `observatory.db` (SQLite, created automatically on first run).

---

## API

The server exposes a small REST + SSE API, useful if you want to build your own integrations:

| Method | Path | Description |
|---|---|---|
| `POST` | `/events` | Receive a hook event (`pre` or `post`) |
| `GET` | `/sessions` | List all sessions with aggregate stats |
| `GET` | `/sessions/{id}/traces` | All traces for a session |
| `DELETE` | `/sessions/{id}` | Delete a session and its traces |
| `GET` | `/stream` | SSE stream of live events |

### Event payload (`POST /events`)

```json
{
  "event":         "pre",
  "session_id":    "abc123",
  "tool_name":     "Agent",
  "tool_input":    {
    "subagent_type": "architecture-reviewer",
    "description":   "Review the PR",
    "prompt":        "..."
  },
  "tool_response": null,
  "timestamp":     1713800000.123
}
```

`"post"` events include `tool_response`. The server matches pre/post pairs by session call stack.

---

## Extending

**New agent icon** — add an entry to `NAMED_ICONS` in `static/app.js`:
```js
[['my-agent-name'], '⬢'],
```

**Custom event sources** — anything that can POST to `/events` with the payload above will appear in the UI. You can instrument your own agent frameworks or CI pipelines.

**Persistent shared instance** — run the server behind nginx or any reverse proxy. The SQLite WAL mode handles concurrent writes safely.

---

## License

MIT
