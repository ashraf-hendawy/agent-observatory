#!/usr/bin/env python3
"""
Agent Observatory — Python Client

Lets any Python-based agent script report to the Observatory without
needing Claude Code or its hook system.

Usage (context manager):

    from observatory_client import Observatory

    obs = Observatory(session_id="my-script", model="claude-sonnet-4-6")

    with obs.agent("researcher", description="Find relevant papers"):
        result = client.messages.create(...)   # your Anthropic SDK call

    with obs.agent("writer", description="Summarise findings"):
        result = client.messages.create(...)

Usage (manual):

    trace_id = obs.start_agent("researcher", prompt="Find papers about X")
    result = client.messages.create(...)
    obs.finish_agent(trace_id, response=result.content[0].text)

Usage (decorator):

    @obs.track(description="Summarise findings")
    def run_agent(prompt):
        return client.messages.create(...).content[0].text

Environment variables:
    AGENT_OBSERVER_URL   Base URL of the Observatory server (default: http://localhost:8765)
"""

import os
import json
import time
import uuid
import urllib.request
import urllib.error
from contextlib import contextmanager
from typing import Optional


class Observatory:
    """Client for posting agent events to the Agent Observatory server."""

    def __init__(
        self,
        session_id: Optional[str] = None,
        model: str = "",
        server_url: Optional[str] = None,
    ):
        self.session_id = session_id or str(uuid.uuid4())
        self.model = model
        self.server_url = server_url or os.environ.get("AGENT_OBSERVER_URL", "http://localhost:8765")
        # Stack of active trace IDs for parent-child inference
        self._stack: list[str] = []
        # Register session
        self._post("/session", {
            "session_id": self.session_id,
            "timestamp": time.time(),
            "is_subagent": 0,
            "model": self.model,
        })

    # ------------------------------------------------------------------
    # Context manager API
    # ------------------------------------------------------------------

    @contextmanager
    def agent(
        self,
        agent_type: str = "general-purpose",
        *,
        description: str = "",
        prompt: str = "",
        model: str = "",
    ):
        """
        Context manager that wraps an agent call.

            with obs.agent("researcher", description="Find papers", prompt=my_prompt):
                result = ...   # set obs.last_response = result before exiting
                obs.last_response = result.content[0].text
        """
        self.last_response = ""
        trace_id = self.start_agent(agent_type, description=description, prompt=prompt, model=model)
        try:
            yield self
            self.finish_agent(trace_id, response=self.last_response)
        except Exception as exc:
            self.finish_agent(trace_id, response=str(exc), interrupted=True)
            raise

    # ------------------------------------------------------------------
    # Decorator API
    # ------------------------------------------------------------------

    def track(
        self,
        agent_type: str = "general-purpose",
        *,
        description: str = "",
        model: str = "",
    ):
        """
        Decorator that automatically records a function call as an agent trace.

            @obs.track(description="Summarise findings")
            def run_agent(prompt: str) -> str:
                return client.messages.create(...).content[0].text
        """
        def decorator(fn):
            def wrapper(*args, **kwargs):
                prompt = str(args[0]) if args else ""
                trace_id = self.start_agent(agent_type, description=description, prompt=prompt, model=model)
                try:
                    result = fn(*args, **kwargs)
                    self.finish_agent(trace_id, response=str(result) if result is not None else "")
                    return result
                except Exception as exc:
                    self.finish_agent(trace_id, response=str(exc), interrupted=True)
                    raise
            wrapper.__name__ = fn.__name__
            return wrapper
        return decorator

    # ------------------------------------------------------------------
    # Manual API
    # ------------------------------------------------------------------

    def start_agent(
        self,
        agent_type: str = "general-purpose",
        *,
        description: str = "",
        prompt: str = "",
        model: str = "",
    ) -> str:
        """Start an agent trace. Returns trace_id to pass to finish_agent()."""
        trace_id = str(uuid.uuid4())
        parent_id = self._stack[-1] if self._stack else None
        self._stack.append(trace_id)

        self._post("/events", {
            "event": "pre",
            "session_id": self.session_id,
            "tool_name": "Agent",
            "tool_input": {
                "subagent_type": agent_type,
                "description": description,
                "prompt": prompt,
            },
            "kind": "agent",
            "model": model or self.model,
            "timestamp": time.time(),
            "_trace_id": trace_id,      # hint for server (ignored if not supported)
            "_parent_id": parent_id,
        })
        return trace_id

    def finish_agent(
        self,
        trace_id: str,
        *,
        response: str = "",
        interrupted: bool = False,
    ) -> None:
        """Close an agent trace opened by start_agent()."""
        if trace_id in self._stack:
            self._stack.remove(trace_id)

        self._post("/events", {
            "event": "post",
            "session_id": self.session_id,
            "tool_name": "Agent",
            "tool_response": response,
            "kind": "agent",
            "model": self.model,
            "timestamp": time.time(),
            "_interrupted": interrupted,
        })

    def tool(self, tool_name: str, *, input_data: dict = None, response: str = "") -> None:
        """Record a single completed tool call (fire-and-forget)."""
        ts = time.time()
        self._post("/events", {
            "event": "pre",
            "session_id": self.session_id,
            "tool_name": tool_name,
            "tool_input": input_data or {},
            "kind": "tool",
            "model": self.model,
            "timestamp": ts,
        })
        self._post("/events", {
            "event": "post",
            "session_id": self.session_id,
            "tool_name": tool_name,
            "tool_response": response,
            "kind": "tool",
            "model": self.model,
            "timestamp": ts + 0.001,
        })

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _post(self, path: str, payload: dict) -> None:
        """POST payload to the Observatory server. Silent on failure."""
        try:
            body = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                f"{self.server_url}{path}",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=2)
        except Exception:
            pass  # Never raise — observability must not break the main script
