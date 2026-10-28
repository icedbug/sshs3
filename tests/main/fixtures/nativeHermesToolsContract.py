"""Driven by Vitest against the packaged interpreter and the real Hermes registry."""

import json
import os
import time
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from hermes_cli.plugins import discover_plugins, invoke_hook
import hermes_cli.main
from model_tools import get_tool_definitions, handle_function_call
from tools.registry import registry

assert Path(hermes_cli.main.__file__).resolve().is_relative_to(Path(os.environ["SSHS3_CONTRACT_ENGINE_ROOT"]).resolve())

discover_plugins()
schema = registry.get_schema("sshs3_terminal_command")
assert schema and "sessionId" not in schema["parameters"]["properties"]
definitions = get_tool_definitions(
    enabled_toolsets=["desktop_ui", "memory", "skills"], quiet_mode=True,
    skip_tool_search_assembly=True,
)
names = {entry["function"]["name"] for entry in definitions}
assert "sshs3_terminal_command" in names
assert "memory" in names

from tools.environments.local import build_subprocess_env
scrubbed = build_subprocess_env(base={
    "SSHS3_NATIVE_TOOL_URL": os.environ["SSHS3_NATIVE_TOOL_URL"],
    "SSHS3_NATIVE_TOOL_KEY": os.environ["SSHS3_NATIVE_TOOL_KEY"], "KEEP": "safe",
})
assert "SSHS3_NATIVE_TOOL_KEY" not in scrubbed
assert "SSHS3_NATIVE_TOOL_URL" not in scrubbed
assert scrubbed["KEEP"] == "safe"

session_id = "real-native-conversation"
compressed_id = "compressed-native-conversation"
from hermes_state import SessionDB
with SessionDB() as db:
    db.create_session(session_id, source="desktop")
    db.create_session(compressed_id, source="desktop", parent_session_id=session_id)
    db.end_session(session_id, "compression")
    assert db.get_compression_lineage(compressed_id)[0] == session_id
invoke_hook("on_session_start", session_id=session_id, platform="desktop", model="local-test")
blocked = json.loads(handle_function_call(
    "terminal", {"command": "echo forbidden"}, task_id="real-native-turn", session_id=session_id,
))
assert "assigned to an sshs3 terminal" in str(blocked)
for bypass in ("computer_use", "drive_preview", "start_chat", "message_agent", "browser_exec", "browser_cdp"):
    directives = invoke_hook("pre_tool_call", tool_name=bypass, args={},
                             task_id="real-native-turn", session_id=session_id)
    assert any(item and item.get("action") == "block" for item in directives), bypass
navigation = invoke_hook("pre_tool_call", tool_name="focus_pane", args={"pane": "chat"},
                         task_id="real-native-turn", session_id=session_id)
assert not any(item and item.get("action") == "block" for item in navigation)

result = json.loads(handle_function_call(
    "sshs3_terminal_command",
    {"command": "echo healthy", "description": "Native dispatcher test", "sessionId": "two", "action": "begin"},
    task_id="real-native-turn", session_id=session_id,
))
assert result["exitCode"] == 0, result
assert result["source"] == "terminal:one", result
invoke_hook("on_session_end", session_id=compressed_id, platform="desktop", completed=True)

# Continuing conversations reuse their stored prompt and do NOT fire
# on_session_start. The integration must renew the same target at the next
# tool call, including a new compression tip; repeated calls remain idempotent.
context = json.loads(handle_function_call(
    "sshs3_terminal_context", {}, task_id=compressed_id, session_id=compressed_id,
))
assert context["source"] == "one", context
context_again = json.loads(handle_function_call(
    "sshs3_terminal_context", {}, task_id=compressed_id, session_id=compressed_id,
))
assert context_again["source"] == "one", context_again
module = sys.modules[registry.get_entry("sshs3_terminal_context").handler.__module__]
with ThreadPoolExecutor(max_workers=1) as pool:
    pending = pool.submit(handle_function_call,
        "sshs3_terminal_command", {"command": "echo must-not-run", "description": "Pending during native Stop"},
        task_id=compressed_id, session_id=compressed_id)
    for _ in range(100):
        if module._rpc("status", compressed_id).get("status") == "waiting":
            break
        time.sleep(0.02)
    else:
        raise AssertionError("Native command never reached approval")
    invoke_hook("agent_loop_stopped", session_key=compressed_id, platform="tui", reason="user_stop")
    cancelled = json.loads(pending.result(timeout=5))
    assert "error" in cancelled, cancelled

# A subsequent tool call must not renew authority after explicit native Stop.
stopped_context = json.loads(handle_function_call(
    "sshs3_terminal_context", {}, task_id=compressed_id, session_id=compressed_id,
))
assert "error" in stopped_context, stopped_context

# Losing the private transport must not turn a previously bound conversation
# into an unrestricted native host operator.
key = os.environ.pop("SSHS3_NATIVE_TOOL_KEY")
try:
    unavailable = invoke_hook("pre_tool_call", tool_name="terminal", args={},
                              task_id="later-native-turn", session_id=session_id)
    assert any(item and item.get("action") == "block" for item in unavailable)
finally:
    os.environ["SSHS3_NATIVE_TOOL_KEY"] = key

# An unbound original Hermes conversation retains its native tool access.
unbound = invoke_hook("pre_tool_call", tool_name="terminal", args={},
                      task_id="other-native-turn", session_id="unbound-conversation")
assert not any(item and item.get("action") == "block" for item in unbound)
print(json.dumps({"nativePlugin": "passed", "target": result["source"], "secretScrub": "passed"}))
