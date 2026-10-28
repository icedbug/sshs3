"""Concrete terminal backend: every command still passes sshs3's ToolBroker."""

from __future__ import annotations

from agent.terminal_env_provider import TerminalEnvironmentProvider


class Sshs3Environment:
    def __init__(self, session_id: str, cwd: str = "", timeout: int = 120):
        self.session_id = session_id
        self.cwd = cwd
        self.timeout = timeout

    def execute(self, command: str, timeout=None, **options):
        if options.get("background"):
            raise RuntimeError("Background execution requires a separately authorized sshs3 job")
        from . import _rpc
        result = _rpc("tool", self.session_id, timeout=720, request={
            "action": "command", "command": command,
            "description": options.get("description") or "Run command in the assigned sshs3 terminal",
        })
        self.cwd = result.get("cwd", self.cwd)
        return {**result, "returncode": result["exitCode"]}

    def cleanup(self):
        # A native cache eviction may neither close the sshs3 PTY nor revoke a
        # different conversation's ownership. The lifecycle hook releases it.
        return None


class Sshs3TerminalProvider(TerminalEnvironmentProvider):
    name = "sshs3"
    display_name = "Assigned sshs3 terminal"
    is_remote = True
    is_container = False

    @property
    def strip_env_keys(self):
        # Applied across ALL providers and subprocesses, even while the native
        # local backend is selected in an unbound conversation.
        return frozenset({"SSHS3_NATIVE_TOOL_URL", "SSHS3_NATIVE_TOOL_KEY"})

    def is_available(self):
        from . import _reachable
        return _reachable()

    def create_environment(self, *, cwd: str, timeout: int, task_id: str = "default", **kwargs):
        from . import _task_owner, _rpc
        # Native dispatch owns task_id. The native pre_tool_call hook captured
        # its conversation in the owning profile, without an env fallback.
        session_id = _task_owner(task_id)
        if not session_id:
            raise RuntimeError("No trusted sshs3 conversation owns this terminal request")
        state = _rpc("status", session_id)
        if not state.get("bound"):
            raise RuntimeError("Assign an sshs3 terminal to this conversation first")
        return Sshs3Environment(session_id, cwd, timeout)
