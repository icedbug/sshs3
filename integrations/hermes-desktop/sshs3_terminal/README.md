# sshs3 native terminal bridge

This application-owned plugin is staged under the pinned Hermes source's
`plugins/sshs3_terminal`. It uses Hermes' original plugin registration, tool
dispatch, native `desktop_ui` toolset, terminal-provider and lifecycle contracts.
Its `backend` kind makes bundled discovery load it for each profile without
modifying that profile's plugin preferences.

## Host wiring

1. Create `NativeToolBridge(getHub, changed)` before importing the original
   Hermes main. `await bridge.start()` opens an IPv4 loopback listener and returns
   `SSHS3_NATIVE_TOOL_URL` and `SSHS3_NATIVE_TOOL_KEY` for that native backend.
   The hub is resolved lazily after sshs3 initializes; no second agent is started.
2. From the authenticated sshs3 terminal renderer call
   `selectTerminal(sessionId)` as selection changes. This affects future
   conversations only. Do not expose selection through an AI tool.
3. After the user confirms an idle prompt and shell, call `armSelected(shell)`.
   It executes the existing correlated shell handshake. Selection alone does
   not grant command execution.
4. Publish `snapshot()` on the bridge's `changed` callback **and** the existing
   HubService change notification. Pending broker approval is represented by
   `binding.task.status === "waiting"` and a pending `task.changes` entry.
   The snapshot includes selected terminal metadata and the immutable bound
   task target. Approval calls `approve(taskId, changeId, approved)` for that
   exact entry. Take control calls `takeover(taskId)`.
5. A reconnect, manual input, interruption or stale session instance blocks
   further tools. After inspecting and rearming the assigned terminal, the user
   may call `resume(taskId)` explicitly. Resuming preserves the terminal ID and
   never replays a command. `resume` enables the next native turn; it does not
   launch an agent.
6. Dispose the bridge before disposing the hub. The listener refuses browser
   origins and missing capabilities. The root IPC layer must restrict every
   host method to its authenticated main renderer frames.

Hermes' `on_session_start` captures the target. `on_session_end` releases PTY
ownership. `agent_loop_stopped` revokes pending approvals immediately when
native Stop is selected. Native SessionDB compression lineage normalizes a
compression tip to the same conversation root; branches and resets stay
separate. Bindings therefore use the compression **root** session ID, rather
than an ephemeral UI/runtime tip ID.

## Authority and scope

Each new assigned task defaults to assisted mode, 30 commands and 15 minutes
per native turn. Commands, verification and file replacements use the existing
ToolBroker. Model arguments cannot provide a target, grant, profile or native
session identity. File access remains bound to the target's actual provider.
Uncertain commands are never retried automatically.

Bound conversations use the five `sshs3_terminal_*` tools. Native terminal/file,
code execution, delegation, chat/Bot spawning, new connector execution, cron
creation and MCP host tools cannot bypass that assignment. Computer use and
interactive preview/browser scripting are also blocked while bound: an agent
may not press its own approval or type through a second host control path.
Passive native layout/navigation/tours remain available. Unbound native conversations retain their
original tools. Native memory, skills, navigation and other UI remain native.
The concrete terminal provider also declares both transport environment keys
as `strip_env_keys`; Hermes removes them from model-authored child processes.
sshs3 must independently omit both variables from its own PTY child environment.

This plugin does not replace native scheduling with scheduled sshs3 sessions,
implement automatic idle-shell detection, or expand current file-provider
limits (complete UTF-8 files under 64 KB). Those are separate product work;
the host must show the actual readiness and authority state.

## Verification

`tests/main/nativeHermesTools.test.ts` covers the live loopback bridge and real
TerminalRegistry/ToolBroker: immutable target, per-profile isolation,
approval/takeover, stale generation, budgets, verification, file-field
whitelisting and capability/origin rejection.

Set `HERMES_NATIVE_CONTRACT=1` when running that Vitest file to additionally use
the sealed native runtime's Python and engine. The default resource is
`build-resources/hermes-native-runtime`; `SSHS3_HERMES_NATIVE_RUNTIME_DIR` can
select a relocated, packaged or installed resource directory. The interpreter
runs with `-I -B`, without a source/PYTHONPATH override. The fixture loads the plugin
through original discovery in an isolated profile and tests original native
dispatch, secret scrubbing, compression continuity, immediate Stop and native
tool preservation for unbound conversations. It makes no model API call and
does not change the user's original Hermes checkout or profile.
