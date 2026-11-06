# sshs3 AI Hub — architecture and implementation status

The AI Hub from the `codex/ai-hub` branch is merged into the main sshs3 code
base (0.97.x): the same `src/main/ai/hub/` services run in the desktop app, in
every tenant of the multi-user Web Server and in demo mode.

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
- **`KnowledgeBaseService`** — hybrid search with `@orama/orama` (BM25 plus
  bilingual Swedish/English concept vectors), memory ranking and ingestion of
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
- **`McpClientManager`** — MCP over stdio and HTTP with a catalog of nine
  presets (`MCP_MARKETPLACE_CATALOG`).
- **`S3WorkspaceSyncService`** — team workspace sync over an S3 bucket. Memory
  entries keep all their metadata (tier, cluster, confidence, success/failure
  and usage counts, feedback score, `autoLearned`, `sourceCommand`,
  `errorSignature`) through S3 and Team Vault sync (`WorkspaceMemoryEntry` in
  `src/shared/types/teamVault.ts`); credentials are never uploaded.

## Source map

- `src/main/desktopEntry.ts`: desktop entry; installs stdio guard and loads `src/main/index.ts`.
- `src/main/ai/hub/`: AI Hub services (HubService, createHub, DirectAgentRuntime, KnowledgeBaseService, SelfLearningService, CommandSafetyService, ContextService, TerminalRegistry, ToolBroker, McpClientManager, S3WorkspaceSyncService, HubStore, privacy, builtins, demoWorkspace).
- `src/main/demo/`: launch-time demo mode, outward sync guard, demo PTY and storage provider.
- `src/main/web/`: multi-user Web Server, authentication, per-user tenants and Electron shim.
- `src/shared/types/aiHub.ts`, `src/shared/types/ai.ts`: hub requests, snapshot, memory, safety policy and provider/model types.
- `src/shared/ipc/createMultiSSHApi.ts`: the `MultiSSHApi` used by both the preload and the web client.
- `src/renderer/src/components/AiHub/`, `src/renderer/src/components/LandingView.tsx`, `src/renderer/src/lib/aiHub.ts`: AI Hub UI.
- `tests/main/workspaceAi.test.ts`, `tests/main/aiHub*.test.ts`, `tests/main/s3WorkspaceSync.test.ts`,
  `tests/main/webServerMultiUser.test.ts`, `tests/main/demo*.test.ts`, `tests/renderer/aiHub.test.tsx`:
  AI Hub, web tenant and demo-mode behavior.
