# sshs3 AI Hub — architecture and implementation status

The AI Hub from the `codex/ai-hub` branch is merged into the main sshs3 code
base (0.97.x): the same `src/main/ai/hub/` services run in the desktop app, in
every tenant of the multi-user Web Server and in demo mode. The pinned
**native Hermes Desktop** host described further down is an optional,
explicitly enabled presentation on top of the same terminal authority.

## Runtime modes

- **Built-in AI Hub (default).** `src/main/desktopEntry.ts` loads
  `src/main/index.ts`, which builds the hub with `createHub(ipcBridge, …)` and
  serves it on the single `HUB_CHANNEL` (`ai-hub:request`) IPC handler in
  `IpcBridge.ts`. The renderer talks to it through `window.multissh.aiHubRequest`
  (`src/renderer/src/lib/aiHub.ts`, `components/AiHub/AiHubPanel.tsx`,
  `components/LandingView.tsx`).
- **Web Server.** `npm run build:web` bundles `src/main/web/serverEntry.ts` into
  `dist-web/server.mjs` (`npm run start:web`). `WebTenantManager` creates one
  isolated set of stores per user — profiles, K8s profiles, Team Vaults,
  snippets, settings — and its own `createHub(…)` instance, so memories,
  knowledge base and agent runs never cross tenants. `electronShim.ts` stands in
  for the Electron APIs (including `nativeImage.createFromBuffer`/`resize`), and
  the browser builds the same `MultiSSHApi` from
  `src/shared/ipc/createMultiSSHApi.ts` over WebSocket (`webClientBridge.ts`).
- **Demo mode.** Decided once at launch (`--demo`, `npm run demo` or
  `SSHS3_DEMO=1`; `src/main/demo/demoMode.ts`) and never persisted. A demo
  process uses its own `demo-workspace` data directory, the `demo-…` fixtures in
  `src/main/ai/hub/demoWorkspace.ts` (virtual PTYs, `DemoStorageProvider`, demo
  knowledge base and MCP servers) and `outwardSync.ts` turns off S3 workspace,
  Team Vault and remote profile sync. Outside demo mode the hub starts from the
  neutral defaults in `src/main/ai/hub/builtins.ts`, and demo-only memories,
  infrastructure edges and knowledge base documents are never written to the
  real `hub.json`.
- **Native Hermes Desktop (opt-in).** Only when `SSHS3_FORCE_NATIVE_HERMES=1` is
  set and the pinned build is staged does `desktopEntry.ts` start the original
  Hermes Desktop GUI; see [Native Hermes Desktop host](#native-hermes-desktop-host).

## AI Hub services (`src/main/ai/hub/`)

- **`HubService`** — the request/action handler (`request(HubRequest)`), agent
  tool implementations (`sshs3_*` tools), scheduler and snapshot. It reaches the
  host app only through the `HubHost` interface that `createHub.ts` implements
  (profiles, Team Vault workspace data, snippets including built-ins, storage
  providers, settings).
- **`DirectAgentRuntime`** — the agent loop for OpenAI Codex (`/responses`),
  OpenAI-compatible (`/chat/completions`) and Anthropic (`/v1/messages`)
  providers. `maxOutputTokens`, `temperature` and `reasoningEffort` from the AI
  configuration are forwarded to every provider, and attached images are sent to
  all three. Fallback models come from `DEFAULT_AI_MODELS` in
  `src/shared/types/ai.ts`.
  The Anthropic loop uses prompt caching: the instructions are a system block
  of their own with a cache breakpoint, the per-run workspace snapshot follows
  it, and a top-level `cache_control` moves the conversation breakpoint each
  tool turn. It sends no `temperature` (current Claude models reject sampling
  parameters) and reports the run's tokens summed over all turns, input read
  from `message_start` including cache writes and reads. A run may only call
  the tools it was offered.
- **`KnowledgeBaseService`** — lexical search with `@orama/orama` (BM25, typo
  tolerance and a hand-written Swedish/English synonym table) and, when the
  provider is an OpenAI-compatible endpoint with `embeddingModel` set, ranking
  by meaning as well: `searchHybrid` embeds the query and the chunks through
  that endpoint's `/embeddings` (`EmbeddingIndex` caches vectors by content
  hash in `kb-embeddings.json`, vectors only) and fuses both rankings by
  reciprocal rank fusion. `sshs3_kb_search` reports which was used
  (`retrieval: "hybrid" | "lexical"`) and why embeddings were not, if they
  failed. ChatGPT/Codex sign-in and Anthropic have no embeddings endpoint, so
  search is lexical there. Also memory ranking and ingestion of
  runbooks from a real S3 storage profile (`kb-ingest-s3` →
  `ingestFromStorageProvider`). The demo StorageGRID documents are used only for
  demo targets.
- **`SelfLearningService`** — learns a fix from a failed command followed by a
  successful one (`learnFromCommandResolution`), writes post-task playbooks
  (`reflectOnCompletedTask`), consolidates memories (`runReflectionCycle`),
  discovers topology edges and applies memory feedback. Commands, snippets and
  output are masked with `privacy.ts` before they are stored; counters and events
  persist in `HubStore` (`selfLearningState`).
- **`TerminalRegistry` / `ToolBroker` / `shellAdapters`** — terminal authority:
  correlated `OSC 777;SSHS3;<nonce>;BEGIN … END;<exit>;<cwd>` framing and
  `OSC 133;D;<exit>` shell integration. A successful command reports the failure
  it resolved (`resolvedFailure`), which drives self-learning for both agent and
  human commands.
- **`CommandSafetyService`** — splits shell commands into segments (pipelines,
  chains, `$()`, backticks, nested `sh -c`/`eval`), classifies them as safe,
  modifying or destructive and applies the `SafetyPolicyConfig`
  (`autoApproveSafeReadOnly`, `requireApprovalOnProdTags`,
  `blockDestructiveWithoutConfirm`), including file writes on `prod`-tagged
  servers.
- **`ContextService`** — builds the agent context; memories scoped to
  `server:<name>` or `cluster:<name>` are included for matching targets and the
  40 highest-ranked memories are kept.
- **Storage operations** — `sshs3_storage_ops` (`list_files`,
  `read_remote_file`, `diff_paths`) runs against real storage providers through
  `HubHost.storageOps`; `diff_paths` produces a Myers unified diff with
  `createTwoFilesPatch` from the `diff` package.
- **`WorkforceRunner`** — a workforce run starts one read-only model run per
  selected Mission Agent (`workspace_context`, `sshs3_kb_search` and
  `sshs3_storage_ops` only; bounded concurrency, at most four specialists) and
  then one run that combines their reports. Every finding in the result is a
  model's own answer; a specialist that cannot run is recorded as failed with
  the provider's error, and without an enabled provider the run is refused.
  Specialist runs are stored as tasks tagged `workforceRunId` and shown inside
  the workforce conversation. Only demo mode plays a scripted run, marked
  `simulated`.
- **Workspace chat (`WorkspaceChat.ts`, `components/AiHub/WorkspaceChat.tsx`)** —
  a chat message is a `chat` event on the team activity log (`channel`,
  `replyTo`, `actorKind`), so it reaches teammates through the transports the
  log already has: the S3 team workspace, Team Vault, the shared workspace file
  and, on the Web Server, directly between signed-in users. `chat-post` stores
  the message (secrets masked); a message that mentions `@ai` is answered in the
  channel by one read-only model run on the poster's own machine, which reads
  the earlier conversation and the workspace through `workspace_context` /
  `sshs3_kb_search`. A run that cannot answer posts the reason. Chat is given
  to agents as `recentTeamChat`, apart from `recentTeamActivity`. Messages share
  the activity log's 500-event cap and retention.
- **`MemoryDistiller` (memory proposals)** — after a finished agent task (and
  on request for the team's recent activity and chat) one tool-less model run
  reads the record together with the team memories that already cover the
  subject and answers with JSON proposals: add a memory/skill or update one it
  was shown. The answer is validated (team scopes only, an update only of a
  shown memory, evidence required, at most four) and stored as
  `memoryProposals`: local, not given to agents and not synced until a person
  accepts one (`memory-proposal-accept`, optionally with corrected text) or
  rejects it. An accepted proposal is an ordinary `MemoryEntry` and syncs like
  one. Personal notes are never shown to that run. `proposeMemories: false`
  turns the per-task run off; the outcome of the latest run, including an
  unusable answer, is `lastMemoryDistill`. This is the extract-and-compare
  method of mem0, done with the configured provider so that it also works with
  ChatGPT/Codex sign-in and keeps the team's existing memory sync.
- **`McpClientManager`** — MCP over stdio and HTTP with a catalog of nine
  presets (`MCP_MARKETPLACE_CATALOG`).
- **`S3WorkspaceSyncService`** — team workspace sync over an S3 bucket. Memory
  entries keep all their metadata (tier, cluster, confidence, success/failure
  and usage counts, feedback score, `autoLearned`, `sourceCommand`,
  `errorSignature`) through S3 and Team Vault sync (`WorkspaceMemoryEntry` in
  `src/shared/types/teamVault.ts`); credentials are never uploaded.

## Native Hermes Desktop host

The pinned Hermes Desktop application can be hosted inside sshs3 (opt-in, see
above). Source/contracts and a Windows x64 packaged GUI were verified for
`0.96.34-ai-hub.3`, with matching Hermes Desktop 0.17.6/engine pin. The complete
original native acceptance plan is not yet fulfilled.

Hermes Desktop and its engine are pinned together at
`f925b01791fe052e7d55dc975750c0bd985aff91` (Desktop 0.17.6). The source pin lives in
`scripts/hermes/desktop-source.json`. Upstream MIT notices are preserved.

The original Electron main, preload, React frontend, contribution registry,
bundled frontend plugins and pooled `hermes serve` backend remain authoritative.
The app-specific adaptations add the sshs3 host, compact presentation and private
terminal tools. sshs3 and Hermes render in separate, kept-alive WebContentsViews;
the two React dependency trees are built independently.

**Terminalfokus** is the compact presentation: chat on the right, a draggable
edge, remembered width and terminal workspace beside it. Expand restores the
full native Hermes layout; the same original chat renderer and stores remain
alive. Native Sessions/Bots navigation, capabilities, plugins, profiles,
gateways, memory, skills, schedules, messaging, artifacts and model/voice
controls are retained in the original UI. Their presence in reused source is
not an operational validation of every feature or configured service.

When the native host is enabled, native Hermes owns conversations, profiles,
schedules, context compression and persistent memory. `HubService` remains the
sshs3 terminal/tool authority (`NativeToolBridge.ts`) and does not start its own
agent runtimes or scheduler in that mode.

Native Hermes uses a persistent application-owned `hermes-native` directory
under sshs3 user data. The standalone Hermes checkout/profile is not overwritten.
Provider/model configuration and authentication use the original native Hermes
settings and profile storage. Existing legacy `AiConfigStore` credentials are
not assumed to be migrated or equivalent to native provider configuration.

## Terminal authority

Select a real sshs3 terminal before starting an assigned conversation. After
checking its idle prompt and choosing its actual shell, explicitly arm it. The
existing correlated shell handshake must finish before the agent can own it.
Selection alone does not allow execution. Human input invalidates prompt
readiness; a reconnect or uncertain command requires inspection and rearming.

The application-owned `sshs3_terminal` backend plugin provides:

- `sshs3_terminal_context`: redacted, source-linked context for the assigned target.
- `sshs3_terminal_command`: visible commands through the existing ToolBroker.
- `sshs3_terminal_verify`: an explicit expected observation and correlated exit status.
- `sshs3_terminal_file_read`: target-provider reads of complete UTF-8 text under 64 KB.
- `sshs3_terminal_file_write`: reviewed replacements with expected-hash checks and read-back.

New assigned conversations default to **assisted** mode with 30 commands and
15 minutes per native turn. Commands and file replacements require approval for
that exact task/change. An expiring private capability connects the native
backend to a loopback broker; browser origins and missing capabilities are
refused. Model arguments never supply a terminal, native profile/session ID,
permission grant or target provider.

The binding is immutable per owning profile and native conversation. Changing
terminal tabs does not retarget it. Hermes' own SessionDB compression lineage
normalizes a new internal compression tip to the same root conversation;
branches and resets remain separate. Native turn-end releases PTY ownership;
native Stop immediately revokes pending approvals. Take control preserves the
interrupted state even if a later native turn-end notification arrives. Explicit
resume retains the target terminal ID and never replays uncertain commands.

Bound conversations cannot bypass that assignment through built-in host
terminal/files, code execution, delegated or newly spawned chats/Bots, connector
execution, cron creation or MCP tools. Computer use and interactive
preview/browser scripting are also blocked while bound, so an agent cannot
press its own approval or type through another host control path. Passive
native navigation/layout/tours and native memory/skills remain available.
Unbound native conversations retain original Hermes tool behavior.

The concrete terminal provider declares both transport environment variables
as `strip_env_keys`, applied by Hermes to model-authored subprocesses regardless
of the active backend. The host also filters those variables from its terminal
children. This is an application authority boundary, not an OS sandbox.

A successful `verify` checks an observed exit code and expected output; it proves
that specific check, not resolution of an entire incident. File read-back checks
bytes, not application behavior. The current file hash recheck does not provide
atomic compare-and-write against an unrelated external writer.

## Build and focused checks

Generated frontend source and runtime distributions are ignored by Git. Stage
the pinned source rather than modifying the user's standalone Hermes checkout:

```sh
npm ci
npm run hermes:desktop:stage
```

Prepare the pinned Hermes frontend dependencies in the staged source with its
upstream lock, or pass a separately prepared checkout with the same lock using
`hermes:desktop:build -- --dependencies PATH`. The build script refuses a
mismatched dependency lock and does not modify an external dependency checkout.

```sh
npm run hermes:desktop:build -- --arch x64
npm run hermes:build -- --out build-resources/hermes-native-runtime --arch x64 --python PATH_TO_BOOTSTRAP_PYTHON
npm run build
```

The runtime builder uses Hermes PM's frozen dependency graph and official
assembler into a separate distribution, validates it and publishes only after
successful imports. The current Windows x64 runtime contains CPython 3.14.7,
matching engine source and sealed dependencies, with managed ffmpeg, Node/npm
and ripgrep. Windows x64 is being packaged/tested on a Windows ARM64 computer;
this is not verification of a Linux or Windows ARM64 package.

The Electron entry checks that frontend and engine commits match and resolves
the interpreter from the runtime manifest. Package the generated desktop and
native runtime together. Never substitute the old f97608f/3.13.16 runtime.
The release resource name for the native runtime is `hermes`.

```sh
npx vitest run tests/main/nativeHermesLayout.test.ts tests/main/nativeDesktopShell.test.ts tests/main/nativeHermesTools.test.ts
npm run typecheck
npm run lint
npm run build
```

Set `HERMES_NATIVE_CONTRACT=1` when running `nativeHermesTools.test.ts` to execute
its actual native Python contract. `SSHS3_HERMES_NATIVE_RUNTIME_DIR` can select
a relocated, packaged or installed runtime instead of
`build-resources/hermes-native-runtime`.

The native CI workflow in `.github/workflows/ai-hub.yml` stages that same source
pin on fresh Windows and Ubuntu runners. It prepares original Desktop workspace
dependencies with the frozen upstream npm lock, assembles the engine through
Hermes PM with a bootstrap Python, and checks matching pins and sealed runtime
health. It then enables the nine native tool contracts, host/layout tests and
actual platform shell matrix (PowerShell/pwsh/cmd on Windows;
bash/sh/dash/zsh/fish on Linux), followed by existing broker/storage regressions,
typecheck, lint and the production build. Windows also runs the seven sealed
payload target-resolver cases. No provider credentials or model calls are needed.
This workflow has been updated and parsed locally; a GitHub Actions run has not
been executed or recorded for this revision. It does not yet verify packaged
Linux GUI behavior or the complete original acceptance plan.

## Verification recorded

- **Nine native tool tests passed against the new CPython 3.14.7 x64 sealed
  runtime**, invoked with `-I -B` and no source/PYTHONPATH override. The fixture
  verifies that the actual core import belongs to the runtime's manifest repo.
  It exercises original plugin discovery and dispatcher identities, target
  immutability, profile isolation, approvals/takeover, stale instances, budgets,
  verification, secret scrubbing, compression continuity, immediate native Stop
  and retained unbound native tool behavior. No model API call is made.
  The same nine tests also passed with
  `SSHS3_HERMES_NATIVE_RUNTIME_DIR=release/ai-hub/win-unpacked/resources/hermes`,
  exercising the actual packaged interpreter and engine imports.
  They also passed against the installed runtime at
  `C:\Users\jacob\AppData\Local\Programs\sshs3-ai-hub\resources\hermes`.
- **The packaged Windows x64 GUI was exercised on Windows ARM64:** the original
  navigation and Bots were reachable. A draft entered in the right panel survived
  expansion, collapse and full process close/reopen. A real divider drag changed
  the panel width from 380 to 526 pixels, and the width persisted. These checks
  do not establish every native feature flow or recovery of a running PTY/job.
- **Twelve native host/factory tests passed** for authenticated main-frame IPC,
  iframe rejection, terminal reuse across presentations, resizing/width
  persistence, drag coalescing, cleanup and blocked navigation/popups. These are
  behavioral host tests; the separate packaged-GUI checks above exercised the
  actual presentation and draft behavior.
- **Three actual Windows PTY tests passed**, covering the Windows shell integration.
  **Forty-three existing regression tests passed**. Together with the nine native
  tool and twelve host/factory checks, this is **67 focused passing tests**.
- Typecheck, lint and production build passed. The Windows x64 installer completed
  with exit code 0 and the installed application launched from
  `C:\Users\jacob\AppData\Local\Programs\sshs3-ai-hub\sshs3-ai-hub.exe`.
  Its installed interpreter passed the native contracts. The installed ASAR
  version is `0.96.34-ai-hub.3`; native Desktop 0.17.6 and the engine match the
  `f925b01791fe052e7d55dc975750c0bd985aff91` pin.
- **The installed GUI check passed:** original Sessions/Bots navigation and the
  Hermes `@hermes` roster entry marked Ready were present. Full native navigation
  and Return to the correct right chat worked. An actual local PowerShell 7 prompt
  was visible beside the chat, with the Local/pwsh target and You control state.
  Provider choice was skipped without authentication or key changes; the native
  provider is currently unconfigured. This does not establish model operation or
  deeper original feature flows.
- The standalone Hermes source, profile and credentials are untouched by these
  tests. No paid model, production SSH/Kubernetes target or hardware credential
  flow has been tested in this revision. Linux remains untested.

## Remaining acceptance work

1. Configure a provider/model and verify real native agent behavior and deeper
   feature flows. Installation, installed GUI and installed-runtime contracts
   have passed for `0.96.34-ai-hub.3` / Hermes 0.17.6 at the f925b01 pin. The
   packaged draft continuity, expansion/collapse, process reopen and real
   resizing/persistence checks have also passed; model/authentication flows and
   deeper configured native features remain unverified.
2. Implement/verify a separately reconnectable per-user background owner and
   renderer recovery. Kept-alive views alone do not prove daemon reconnect after
   window destruction, crash, restart or computer sleep.
3. Replace manual idle-shell arming with reliable prompt integration and explicit
   interactive/authentication/nested-SSH states. Existing wrappers cover the
   listed shell families, but the full Linux/WSL/SSH/Kubernetes matrix and failure
   scenarios have not been validated for this native revision.
4. Complete the searchable terminal event journal, scoped infrastructure
   inventory, server-group attachments, actionable evidence and privacy checks.
   Native Hermes memory/context is preserved, but this does not establish all
   planned sshs3 environment-memory and inventory requirements.
5. Map native schedules to separately identified, explicitly authorized sshs3
   sessions with fixed targets/budgets and missed-run handling. Native scheduling
   UI/backend is retained; it is not yet this target-bound scheduler.
6. Finish feature-by-feature configured operation checks, model interruption and
   authentication tests, device sleep/restart/network-loss recovery, representative
   isolated incidents, model cost and terminal latency measurements, and actual
   Windows/Linux package validation. Optional upstream `get-windows` is absent in
   the current dependency tree; dependent native window-enumeration functionality
   must not be advertised as verified.

The structured inventory in `docs/hermes-feature-inventory.json` separates
preserved native source, verified contracts, setup-dependent operations and
remaining platform/product work.

## Source map

- `src/main/desktopEntry.ts`: desktop entry; launches the pinned native engine/frontend only with `SSHS3_FORCE_NATIVE_HERMES=1`.
- `src/main/ai/hub/`: AI Hub services (HubService, createHub, DirectAgentRuntime, KnowledgeBaseService, SelfLearningService, CommandSafetyService, ContextService, TerminalRegistry, ToolBroker, McpClientManager, S3WorkspaceSyncService, HubStore, privacy, builtins, demoWorkspace).
- `src/main/ai/desktop/`: native Hermes host views, authenticated control IPC and NativeToolBridge.
- `src/main/demo/`: launch-time demo mode, outward sync guard, demo PTY and storage provider.
- `src/main/web/`: multi-user Web Server, authentication, per-user tenants and Electron shim.
- `src/shared/types/aiHub.ts`, `src/shared/types/ai.ts`: hub requests, snapshot, memory, safety policy and provider/model types.
- `src/shared/ipc/createMultiSSHApi.ts`: the `MultiSSHApi` used by both the preload and the web client.
- `src/renderer/src/components/AiHub/`, `src/renderer/src/components/LandingView.tsx`, `src/renderer/src/lib/aiHub.ts`: AI Hub UI.
- `integrations/hermes-desktop/`: narrow original desktop adaptations and backend plugin.
- `src/shared/types/nativeHermes.ts`: host layout/control contracts.
- `scripts/hermes/`: pinned source, original desktop build and PM-based runtime packaging.
- `tests/main/workspaceAi.test.ts`, `tests/main/aiHub*.test.ts`, `tests/main/s3WorkspaceSync.test.ts`,
  `tests/main/webServerMultiUser.test.ts`, `tests/main/demo*.test.ts`, `tests/renderer/aiHub.test.tsx`:
  AI Hub, web tenant and demo-mode behavior.
- `tests/main/nativeHermes*.test.ts`, `tests/main/nativeDesktopShell.test.ts`:
  host and actual native engine contracts.
