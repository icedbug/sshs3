"""Private sshs3 transport over Hermes' public plugin contract.

The application capability is process-scoped. Conversation identity is resolved
from Hermes' trusted kwargs and current profile scope on EVERY call.
"""

from __future__ import annotations

import http.client
import json
import os
import sqlite3
import threading
from collections import OrderedDict
from urllib.parse import urlsplit


PROTECTED_TOOLSETS = frozenset({
    "terminal", "file", "code_execution", "delegation", "connections", "cronjob", "computer_use", "start_chat",
})
PROTECTED_TOOLS = frozenset({
    "terminal", "process_manage", "read_file", "write_file", "patch", "search_files",
    "execute_code", "delegate_task", "manage_connections", "cronjob_manage",
    "read_terminal", "close_terminal", "desktop_preview",
    "open_terminal", "write_terminal", "run_terminal", "computer_use", "drive_preview",
    "browser_exec", "browser_cdp", "start_chat", "message_agent",
})
_TASK_OWNERS = OrderedDict()
_OWNER_LOCK = threading.Lock()
_FAILED_STARTS = set()
_BOUND_IDENTITIES = set()
_CANONICAL_IDS = {}


def _profile_key():
    from hermes_constants import get_hermes_home
    return str(get_hermes_home().resolve())


def _task_owner(task_id: str):
    with _OWNER_LOCK:
        return _TASK_OWNERS.get((_profile_key(), task_id))


def _canonical_session(session_id: str):
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("Hermes did not provide a trusted conversation identity")
    from hermes_constants import get_hermes_home
    identity = (_profile_key(), session_id)
    with _OWNER_LOCK:
        cached = _CANONICAL_IDS.get(identity)
    if cached:
        return cached
    database = get_hermes_home() / "state.db"
    if not database.exists():
        return session_id
    from hermes_state import SessionDB
    try:
        with SessionDB(database, read_only=True) as db:
            lineage = db.get_compression_lineage(session_id)
        if lineage:
            with _OWNER_LOCK:
                for member in lineage:
                    _CANONICAL_IDS[(identity[0], member)] = lineage[0]
        return lineage[0] if lineage else session_id
    except sqlite3.Error as error:
        raise RuntimeError("Unable to verify Hermes conversation lineage") from error


def _reachable() -> bool:
    return bool(os.environ.get("SSHS3_NATIVE_TOOL_URL") and os.environ.get("SSHS3_NATIVE_TOOL_KEY"))


def _owner(session_id: str) -> dict[str, str]:
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("Hermes did not provide a trusted conversation identity")
    return {"profileHome": _profile_key(), "sessionId": _canonical_session(session_id)}


def _rpc(action: str, session_id: str, *, timeout: float = 2, **fields):
    destination = urlsplit(os.environ.get("SSHS3_NATIVE_TOOL_URL", ""))
    key = os.environ.get("SSHS3_NATIVE_TOOL_KEY", "")
    if (destination.scheme != "http" or destination.hostname != "127.0.0.1"
            or not destination.port or destination.path != "/native-tool"
            or destination.query or destination.username or destination.password or not key):
        raise RuntimeError("sshs3 terminal integration is unavailable")
    payload = json.dumps({"action": action, "owner": _owner(session_id), **fields}).encode("utf-8")
    connection = http.client.HTTPConnection("127.0.0.1", destination.port, timeout=timeout)
    try:
        connection.request("POST", "/native-tool", body=payload, headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json",
        })
        response = connection.getresponse()
        raw = response.read(1_048_577)
        if len(raw) > 1_048_576:
            raise RuntimeError("sshs3 tool result exceeded the response limit")
        result = json.loads(raw)
        if response.status != 200 or "error" in result:
            raise RuntimeError(result.get("error", "sshs3 refused this operation"))
        return result.get("result")
    finally:
        connection.close()


def _on_start(session_id: str = "", platform: str = "", **_):
    if _reachable():
        session_id = _canonical_session(session_id)
        identity = (_profile_key(), session_id)
        try:
            result = _rpc("begin", session_id, platform=platform)
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            with _OWNER_LOCK:
                _FAILED_STARTS.add(identity)
            raise
        with _OWNER_LOCK:
            _FAILED_STARTS.discard(identity)
            if result.get("bound"):
                _BOUND_IDENTITIES.add(identity)
        return result


def _on_end(session_id: str = "", interrupted: bool = False, failed: bool = False, **_):
    if _reachable() and session_id:
        session_id = _canonical_session(session_id)
        try:
            return _rpc("end", session_id, interrupted=interrupted, failed=failed)
        finally:
            with _OWNER_LOCK:
                for identity, owner in list(_TASK_OWNERS.items()):
                    if identity[0] == _profile_key() and owner == session_id:
                        del _TASK_OWNERS[identity]


def _on_stopped(session_key: str = "", **_):
    if _reachable() and session_key:
        return _on_end(session_key, interrupted=True)


def _protected(tool_name: str) -> bool:
    if tool_name in PROTECTED_TOOLS or tool_name.startswith("mcp_"):
        return True
    from tools.registry import registry
    entry = registry.get_entry(tool_name)
    return bool(entry and entry.toolset in PROTECTED_TOOLSETS)


def _pre_tool(tool_name: str, session_id: str = "", task_id: str = "", **_):
    try:
        session_id = _canonical_session(session_id)
    except (OSError, ValueError, RuntimeError):
        if _reachable() and _protected(tool_name):
            return {"action": "block", "message": "Unable to verify the Hermes conversation identity; host operation blocked."}
        return None
    if task_id and session_id:
        with _OWNER_LOCK:
            _TASK_OWNERS[(_profile_key(), task_id)] = session_id
            while len(_TASK_OWNERS) > 8192:
                _TASK_OWNERS.popitem(last=False)
    if tool_name.startswith("sshs3_terminal_"):
        # Hermes only fires on_session_start when it builds the initial prompt,
        # but on_session_end runs after every message. Renew an EXISTING binding
        # before a later tool call; an empty platform cannot create an assignment.
        # begin is idempotent within a turn and refuses interrupted tasks, stale
        # terminal instances and unready prompts, preserving explicit takeover.
        try:
            state = _rpc("begin", session_id, platform="")
            if not state.get("bound") or not state.get("active"):
                return {"action": "block", "message": state.get("error") or
                        "Select and connect an sshs3 terminal before starting this conversation."}
            with _OWNER_LOCK:
                _BOUND_IDENTITIES.add((_profile_key(), session_id))
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            return {"action": "block", "message":
                    "sshs3 cannot confirm terminal authority. Inspect and explicitly resume the assigned terminal."}
        return None
    if not _protected(tool_name):
        return None
    identity = (_profile_key(), session_id)
    with _OWNER_LOCK:
        previously_bound = identity in _BOUND_IDENTITIES or identity in _FAILED_STARTS
    if not _reachable() and not previously_bound:
        return None
    try:
        with _OWNER_LOCK:
            if identity in _FAILED_STARTS:
                raise RuntimeError("Conversation authority could not be established")
        state = _rpc("status", session_id, timeout=1)
    except (OSError, ValueError, RuntimeError, http.client.HTTPException):
        return {"action": "block", "message": (
            "sshs3 cannot confirm terminal authority. This host operation is blocked; "
            "reconnect or explicitly resume the assigned terminal in sshs3."
        )}
    if state.get("bound"):
        return {"action": "block", "message": (
            "This conversation is assigned to an sshs3 terminal. Use the sshs3_terminal tools "
            "for terminal commands and target files; approvals and target identity are enforced "
            "there. Host tools, new remote connections and delegated execution cannot bypass this assignment."
        )}
    return None


def _handler(action: str):
    def handle(args: dict, session_id: str = "", **_):
        # Whitelist fields, then overwrite action. Host/session IDs from the model are discarded.
        request = {name: args[name] for name in (
            "command", "query", "path", "content", "expected", "description",
        ) if name in args}
        request["action"] = action
        try:
            if action == "command":
                from .environment import Sshs3Environment
                result = Sshs3Environment(session_id).execute(
                    request.get("command", ""), description=request.get("description"),
                )
            else:
                result = _rpc("tool", session_id, timeout=720, request=request)
            return json.dumps(result, ensure_ascii=False)
        except (OSError, ValueError, RuntimeError, http.client.HTTPException) as error:
            return json.dumps({"error": str(error)}, ensure_ascii=False)
    return handle


def register(ctx):
    from .environment import Sshs3TerminalProvider
    ctx.register_terminal_environment_provider(Sshs3TerminalProvider())
    ctx.register_hook("on_session_start", _on_start)
    ctx.register_hook("on_session_end", _on_end)
    ctx.register_hook("agent_loop_stopped", _on_stopped)
    ctx.register_hook("pre_tool_call", _pre_tool)
    definitions = [
        ("context", "context", "Read redacted, source-linked context for the assigned sshs3 terminal.", {
            "query": {"type": "string", "description": "Optional search for relevant observations."},
        }, []),
        ("command", "command", "Run a command visibly in the assigned sshs3 terminal. Read sshs3_terminal_context first and use that target's shell and cwd. Requires user approval; wait for correlated shell completion.", {
            "command": {"type": "string"}, "description": {"type": "string"},
        }, ["command", "description"]),
        ("verify", "verify", "Run a verification command in the assigned sshs3 terminal and check an explicit expected output. Use the shell shown by sshs3_terminal_context. Approval is required.", {
            "command": {"type": "string"}, "expected": {"type": "string"}, "description": {"type": "string"},
        }, ["command", "expected", "description"]),
        ("file_read", "file-read", "Read a complete UTF-8 text file under 64 KB on the assigned sshs3 target. Returns a content hash; secrets are redacted.", {
            "path": {"type": "string", "description": "Absolute path on the assigned target."},
        }, ["path"]),
        ("file_write", "file-write", "Propose a file replacement on the assigned target using its previously read hash. User approval and read-back verification are required.", {
            "path": {"type": "string"}, "content": {"type": "string"}, "expected": {"type": "string", "description": "Expected hash returned by the previous file read."},
            "description": {"type": "string"},
        }, ["path", "content", "expected", "description"]),
    ]
    for suffix, action, description, properties, required in definitions:
        name = "sshs3_terminal_" + suffix
        ctx.register_tool(
            name=name, toolset="desktop_ui", handler=_handler(action), check_fn=_reachable,
            description="sshs3 assigned terminal", emoji="🖥️",
            schema={"name": name, "description": description, "parameters": {
                "type": "object", "properties": properties, "required": required,
                "additionalProperties": False,
            }},
        )
