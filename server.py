#!/usr/bin/env python3
"""
Agent Observatory — Backend Server

Receives Claude Code hook events and serves the real-time web UI.
Stores traces in SQLite for persistence across restarts.

Usage:
    python server.py [--port 8765] [--host 0.0.0.0]
"""

import argparse
import asyncio
import json
import random
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Funny name generator (used when subagent_type is not specified)
# ---------------------------------------------------------------------------

_ADJECTIVES = [
    "Jazzy", "Turbo", "Cosmic", "Sneaky", "Fluffy", "Grumpy", "Bouncy",
    "Zesty", "Crispy", "Wobbly", "Spicy", "Sleepy", "Chaotic", "Mighty",
    "Tiny", "Sassy", "Funky", "Chonky", "Wiggly", "Dramatic",
]

_ANIMALS = [
    "Raccoon", "Penguin", "Narwhal", "Capybara", "Platypus", "Axolotl",
    "Quokka", "Pangolin", "Meerkat", "Blobfish", "Tardigrade", "Wombat",
    "Ocelot", "Tapir", "Manatee", "Numbat", "Kinkajou", "Binturong",
    "Fossa", "Saiga",
]


# ---------------------------------------------------------------------------
# Pricing (Claude Sonnet 4.6 — adjust if using a different model)
# Token counts are estimated from text length (4 chars ≈ 1 token).
# ---------------------------------------------------------------------------

CHARS_PER_TOKEN = 3.5    # Claude tokenizer: ~3.5 chars/token for mixed English/code
TRUNCATE_LIMIT  = 12_000 # max bytes stored for prompt/response fields

# ---------------------------------------------------------------------------
# Per-model pricing (USD per 1M tokens). Source: anthropic.com/pricing
# Entries are checked in order — more specific patterns first.
# ---------------------------------------------------------------------------
_MODEL_PRICING: list[tuple[tuple[str, ...], float, float]] = [
    # Claude Opus 4.5 / 4.6 / 4.7  ($5 / $25)
    (("claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7",
      "opus-4-5", "opus-4-6", "opus-4-7"),            5.00, 25.00),
    # Claude Opus 4.0 deprecated    ($15 / $75)
    (("claude-opus-4-0", "opus-4-0"),                15.00, 75.00),
    # Claude Sonnet 4.x             ($3 / $15)
    (("claude-sonnet-4", "sonnet-4"),                 3.00, 15.00),
    # Claude Haiku 4.5              ($1 / $5)
    (("claude-haiku-4-5", "haiku-4-5",
      "claude-haiku-4", "haiku-4"),                   1.00,  5.00),
    # Claude Sonnet 3.7 / 3.5      ($3 / $15)
    (("claude-3-7-sonnet", "claude-3-5-sonnet",
      "sonnet-3-7", "sonnet-3-5"),                    3.00, 15.00),
    # Claude Haiku 3.5              ($0.80 / $4)
    (("claude-3-5-haiku", "haiku-3-5"),               0.80,  4.00),
    # Claude Opus 3                 ($15 / $75)
    (("claude-3-opus", "opus-3"),                    15.00, 75.00),
    # Claude Haiku 3                ($0.25 / $1.25)
    (("claude-3-haiku", "haiku-3"),                   0.25,  1.25),
    # Generic tier fallbacks (matched last)
    (("opus",),                                       5.00, 25.00),  # assume modern Opus
    (("sonnet",),                                     3.00, 15.00),
    (("haiku",),                                      1.00,  5.00),  # assume modern Haiku
]

_DEFAULT_INPUT_PRICE  = 3.00   # Sonnet pricing as safe default
_DEFAULT_OUTPUT_PRICE = 15.00


def _price_for_model(model: str) -> tuple[float, float]:
    """Return (input_price_per_M, output_price_per_M) for a model string."""
    m = (model or "").lower()
    for keywords, inp, out in _MODEL_PRICING:
        if any(k in m for k in keywords):
            return inp, out
    return _DEFAULT_INPUT_PRICE, _DEFAULT_OUTPUT_PRICE


def estimate_cost(prompt: str, response: str, model: str = "") -> tuple[int, int, float]:
    """Return (input_tokens, output_tokens, cost_usd) — all estimates."""
    input_tokens  = int(len(prompt)   / CHARS_PER_TOKEN)
    output_tokens = int(len(response) / CHARS_PER_TOKEN)
    inp_price, out_price = _price_for_model(model)
    cost = (input_tokens * inp_price + output_tokens * out_price) / 1_000_000
    return input_tokens, output_tokens, round(cost, 6)


def funny_name() -> str:
    return f"{random.choice(_ADJECTIVES)} {random.choice(_ANIMALS)}"

import logging

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("observatory")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DB_PATH = Path(__file__).parent / "observatory.db"
STATIC_DIR = Path(__file__).parent / "static"

# ---------------------------------------------------------------------------
# In-memory state (lost on restart — traces survive in SQLite)
# ---------------------------------------------------------------------------

# Per-session call stacks: session_id -> [trace_id, ...]
# Used to infer parent-child relationships from sequential hook events.
session_stacks: dict[str, list[str]] = {}

# Per-session tool stacks: session_id -> tool_name -> [trace_id, ...]
# Separate from agent stacks so tool pre/post events close the right trace.
session_tool_stacks: dict[str, dict[str, list[str]]] = {}

# SSE client queues
sse_clients: list[asyncio.Queue] = []


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id          TEXT PRIMARY KEY,
                started_at  REAL NOT NULL,
                last_seen   REAL NOT NULL,
                trace_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS traces (
                id           TEXT PRIMARY KEY,
                session_id   TEXT NOT NULL REFERENCES sessions(id),
                parent_id    TEXT,
                agent_type   TEXT NOT NULL DEFAULT 'unknown',
                description  TEXT NOT NULL DEFAULT '',
                prompt       TEXT NOT NULL DEFAULT '',
                response     TEXT,
                status        TEXT NOT NULL DEFAULT 'running',
                started_at    REAL NOT NULL,
                completed_at  REAL,
                duration_ms   INTEGER,
                input_tokens  INTEGER,
                output_tokens INTEGER,
                cost_usd      REAL
            );

            CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);

            -- Agent-to-agent message board
            CREATE TABLE IF NOT EXISTS board_messages (
                id         TEXT PRIMARY KEY,
                board_id   TEXT NOT NULL,
                agent_name TEXT NOT NULL DEFAULT 'unknown',
                content    TEXT NOT NULL DEFAULT '',
                reply_to   TEXT,
                timestamp  REAL NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_board ON board_messages(board_id);

            -- Mark any traces left in 'running' state from a previous server
            -- session as 'interrupted' so the UI doesn't show stuck spinners.
            UPDATE traces SET status = 'interrupted'
            WHERE status = 'running';
        """)
        # Migrate older DBs that lack the cost columns
        for col, typ in [("input_tokens", "INTEGER"), ("output_tokens", "INTEGER"), ("cost_usd", "REAL")]:
            try:
                conn.execute(f"ALTER TABLE traces ADD COLUMN {col} {typ}")
            except Exception:
                pass
        # Migrate: tool activity kind column
        try:
            conn.execute("ALTER TABLE traces ADD COLUMN kind TEXT DEFAULT 'agent'")
        except Exception:
            pass
        # Migrate: subagent session columns
        for col, typ in [("is_subagent", "INTEGER DEFAULT 0"), ("parent_session_id", "TEXT")]:
            try:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {typ}")
            except Exception:
                pass
        # Migrate: session_id on board_messages for per-session board scoping
        try:
            conn.execute("ALTER TABLE board_messages ADD COLUMN session_id TEXT")
        except Exception:
            pass
        # Migrate: model tracking for per-model cost estimation
        try:
            conn.execute("ALTER TABLE traces ADD COLUMN model TEXT DEFAULT ''")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN model TEXT DEFAULT ''")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# SSE broadcasting
# ---------------------------------------------------------------------------

async def broadcast(event: dict) -> None:
    """Push an event to all connected SSE clients."""
    dead: list[asyncio.Queue] = []
    for q in sse_clients:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        try:
            sse_clients.remove(q)
        except ValueError:
            pass


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
    init_db()
    yield


app = FastAPI(title="Agent Observatory", lifespan=lifespan)

# Reject request bodies larger than 1 MB to prevent memory exhaustion
MAX_BODY_BYTES = 1 * 1024 * 1024  # 1 MB

class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method == "POST":
            content_length = request.headers.get("content-length")
            if content_length and int(content_length) > MAX_BODY_BYTES:
                from fastapi.responses import JSONResponse
                return JSONResponse({"ok": False, "error": "request body too large"}, status_code=413)
        return await call_next(request)

app.add_middleware(BodySizeLimitMiddleware)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def root():
    return (STATIC_DIR / "index.html").read_text()


@app.post("/events")
async def receive_event(request: Request):
    """
    Called by hook.py on every PreToolUse / PostToolUse event for the Agent tool.

    Expected payload:
        {
            "event":         "pre" | "post",
            "session_id":    str,
            "tool_name":     str,
            "tool_input":    { subagent_type, prompt, description, ... },
            "tool_response": str | null,
            "timestamp":     float   # unix seconds
        }
    """
    try:
        data: dict = await request.json()
    except Exception:
        logger.warning("POST /events — invalid JSON from %s", request.client)
        return {"ok": False, "error": "invalid JSON"}

    event_type: str = data.get("event", "")
    session_id: str = data.get("session_id") or "unknown"
    tool_input: dict = data.get("tool_input") or {}
    tool_response: Optional[str] = data.get("tool_response")
    tool_name: str = data.get("tool_name") or ""
    kind: str = data.get("kind") or "agent"
    model: str = data.get("model") or ""
    ts: float = data.get("timestamp") or time.time()

    with get_db() as conn:
        # Upsert the session row (without touching is_subagent — already set by /session)
        conn.execute(
            """
            INSERT INTO sessions (id, started_at, last_seen, trace_count)
            VALUES (?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen
            """,
            (session_id, ts, ts),
        )

        if event_type == "pre":
            # ----------------------------------------------------------------
            # A new trace is starting — agent spawn or tool call.
            # ----------------------------------------------------------------
            trace_id = str(uuid.uuid4())
            stack = session_stacks.setdefault(session_id, [])
            parent_id = stack[-1] if stack else None

            if kind == "agent":
                # Agent spawn: push onto agent stack so its tool children nest under it
                stack.append(trace_id)

                description = tool_input.get("description") or ""
                prompt = (tool_input.get("prompt") or "")[:TRUNCATE_LIMIT]

                agent_type = (
                    tool_input.get("subagent_type")
                    or tool_input.get("agent_type")
                    or ""
                )
                if not agent_type or agent_type in ("unknown", "general-purpose"):
                    agent_type = description or funny_name()

                conn.execute(
                    "UPDATE sessions SET trace_count = trace_count + 1 WHERE id = ?",
                    (session_id,),
                )
            else:
                # Tool call: push onto per-tool stack for matching with its post event
                session_tool_stacks.setdefault(session_id, {}).setdefault(tool_name, []).append(trace_id)
                description = ""
                prompt = json.dumps(tool_input)[:TRUNCATE_LIMIT]
                agent_type = tool_name  # e.g. "Bash", "Read", "Write"

            conn.execute(
                """
                INSERT INTO traces
                    (id, session_id, parent_id, agent_type, description,
                     prompt, status, started_at, kind, model)
                VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
                """,
                (trace_id, session_id, parent_id, agent_type, description, prompt, ts, kind, model),
            )

            await broadcast(
                {
                    "type": "trace_started",
                    "trace_id": trace_id,
                    "session_id": session_id,
                    "parent_id": parent_id,
                    "agent_type": agent_type,
                    "description": description,
                    "kind": kind,
                    "started_at": ts,
                }
            )

        elif event_type == "post":
            # ----------------------------------------------------------------
            # A trace has completed — close its record.
            # ----------------------------------------------------------------
            if kind == "agent":
                stack = session_stacks.get(session_id, [])
                if not stack:
                    return {"ok": True, "note": "no pending agent trace to close"}
                trace_id = stack.pop()
            else:
                tool_stack = session_tool_stacks.get(session_id, {}).get(tool_name, [])
                if not tool_stack:
                    return {"ok": True, "note": "no pending tool trace to close"}
                trace_id = tool_stack.pop()
            row = conn.execute(
                "SELECT started_at, prompt, model FROM traces WHERE id = ?", (trace_id,)
            ).fetchone()
            duration_ms = int((ts - row["started_at"]) * 1000) if row else 0

            # Normalise response: could be string or list of content blocks
            response_text = _normalise_response(tool_response)[:TRUNCATE_LIMIT]

            # Estimate token counts and cost — use model from trace or fallback to payload
            prompt_text = row["prompt"] if row else ""
            trace_model = (row["model"] if row else "") or model
            input_tok, output_tok, cost = estimate_cost(prompt_text, response_text, trace_model)

            conn.execute(
                """
                UPDATE traces
                SET response      = ?,
                    status        = 'completed',
                    completed_at  = ?,
                    duration_ms   = ?,
                    input_tokens  = ?,
                    output_tokens = ?,
                    cost_usd      = ?
                WHERE id = ?
                """,
                (response_text, ts, duration_ms, input_tok, output_tok, cost, trace_id),
            )

            await broadcast(
                {
                    "type": "trace_completed",
                    "trace_id": trace_id,
                    "session_id": session_id,
                    "duration_ms": duration_ms,
                    "completed_at": ts,
                    "input_tokens":  input_tok,
                    "output_tokens": output_tok,
                    "cost_usd":      cost,
                }
            )

    return {"ok": True}


@app.post("/session")
async def register_session(request: Request):
    """
    Called by hook.py on any tool use to ensure the session is registered
    as early as possible — before any Agent tool is spawned.
    """
    try:
        data: dict = await request.json()
    except Exception:
        logger.warning("POST /session — invalid JSON from %s", request.client)
        return {"ok": False, "error": "invalid JSON"}

    session_id: str = data.get("session_id") or "unknown"
    ts: float = data.get("timestamp") or time.time()
    is_subagent: int = int(data.get("is_subagent") or 0)
    parent_session_id: Optional[str] = data.get("parent_session_id")
    model: str = data.get("model") or ""

    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()

        conn.execute(
            """
            INSERT INTO sessions (id, started_at, last_seen, trace_count, is_subagent, parent_session_id, model)
            VALUES (?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen,
                                          model = COALESCE(NULLIF(excluded.model, ''), model)
            """,
            (session_id, ts, ts, is_subagent, parent_session_id, model),
        )

        # Only announce root sessions to the UI
        if not existing and not is_subagent:
            await broadcast({
                "type": "session_created",
                "session_id": session_id,
                "started_at": ts,
            })

    return {"ok": True}


@app.get("/sessions")
async def list_sessions():
    """Return the 50 most recently active sessions with aggregate stats."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT
                s.id,
                s.started_at,
                s.last_seen,
                s.trace_count,
                COUNT(CASE WHEN t.status = 'running'     AND (t.kind = 'agent' OR t.kind IS NULL) THEN 1 END) AS running_count,
                COUNT(CASE WHEN t.status = 'interrupted' AND (t.kind = 'agent' OR t.kind IS NULL) THEN 1 END) AS failed_count,
                COALESCE(SUM(t.duration_ms), 0)                      AS total_agent_ms,
                COALESCE(MAX(t.completed_at) - MIN(t.started_at), 0) AS wall_time_s,
                COALESCE(SUM(t.input_tokens),  0)                    AS total_input_tokens,
                COALESCE(SUM(t.output_tokens), 0)                    AS total_output_tokens,
                COALESCE(SUM(t.cost_usd),      0)                    AS total_cost_usd
            FROM sessions s
            LEFT JOIN traces t ON t.session_id = s.id
            WHERE s.is_subagent = 0
            GROUP BY s.id
            ORDER BY s.last_seen DESC
            LIMIT 50
            """
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/sessions/{session_id}/traces")
async def get_traces(session_id: str):
    """Return all traces for a session, ordered by start time."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT id, parent_id, agent_type, description, prompt, response,
                   status, started_at, completed_at, duration_ms,
                   input_tokens, output_tokens, cost_usd, kind, model
            FROM traces
            WHERE session_id = ?
            ORDER BY started_at ASC
            """,
            (session_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/stream")
async def sse_stream(request: Request):
    """Server-Sent Events endpoint for real-time updates."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    sse_clients.append(queue)

    async def generate():
        try:
            yield 'data: {"type":"connected"}\n\n'
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=25.0)
                    yield f"data: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield 'data: {"type":"ping"}\n\n'
        finally:
            try:
                sse_clients.remove(queue)
            except ValueError:
                pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.get("/boards")
async def list_boards(session_id: Optional[str] = None):
    """Return boards for a session, ordered by most recent activity."""
    with get_db() as conn:
        if session_id:
            rows = conn.execute("""
                SELECT board_id,
                       COUNT(*)        AS message_count,
                       MAX(timestamp)  AS last_activity,
                       MIN(timestamp)  AS started_at
                FROM board_messages
                WHERE session_id = ?
                GROUP BY board_id
                ORDER BY last_activity DESC
                LIMIT 30
            """, (session_id,)).fetchall()
        else:
            rows = conn.execute("""
                SELECT board_id,
                       COUNT(*)        AS message_count,
                       MAX(timestamp)  AS last_activity,
                       MIN(timestamp)  AS started_at
                FROM board_messages
                GROUP BY board_id
                ORDER BY last_activity DESC
                LIMIT 30
            """).fetchall()
    return [dict(r) for r in rows]


@app.get("/board/{board_id}")
async def get_board(board_id: str):
    """Return all messages for a board in chronological order."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM board_messages WHERE board_id = ? ORDER BY timestamp ASC",
            (board_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/board/{board_id}")
async def post_to_board(board_id: str, request: Request):
    """Post a new message to a board. Broadcasts to all SSE clients."""
    try:
        data: dict = await request.json()
    except Exception:
        logger.warning("POST /board/%s — invalid JSON from %s", board_id, request.client)
        return {"ok": False, "error": "invalid JSON"}

    msg = {
        "id":         str(uuid.uuid4()),
        "board_id":   board_id,
        "session_id": data.get("session_id") or None,
        "agent_name": (data.get("agent_name") or "unknown")[:80],
        "content":    (data.get("content")    or "")[:4_000],
        "reply_to":   data.get("reply_to"),
        "timestamp":  time.time(),
    }

    with get_db() as conn:
        conn.execute(
            """INSERT INTO board_messages (id, board_id, session_id, agent_name, content, reply_to, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (msg["id"], msg["board_id"], msg["session_id"], msg["agent_name"],
             msg["content"], msg["reply_to"], msg["timestamp"]),
        )

    await broadcast({"type": "board_message", "board_id": board_id, "session_id": msg["session_id"], "message": msg})
    return msg


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Remove a session and all its traces."""
    with get_db() as conn:
        conn.execute("DELETE FROM traces WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM board_messages WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    if session_id in session_stacks:
        del session_stacks[session_id]
    if session_id in session_tool_stacks:
        del session_tool_stacks[session_id]
    return {"ok": True}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalise_response(value) -> str:
    """Convert various tool_response shapes to a plain string."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for block in value:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                parts.append(block.get("text") or json.dumps(block))
        return "\n".join(parts)
    return str(value)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Agent Observatory server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    uvicorn.run(
        "server:app",
        host=args.host,
        port=args.port,
        reload=False,
        log_level="info",
    )
