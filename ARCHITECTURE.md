# sshs3 Architecture & Developer Guide

This document outlines the architecture, process boundaries, design patterns, and conventions of **sshs3**. It is designed to help developers and AI assistants navigate, modify, and extend the codebase safely and consistently.

---

## 1. System Overview & Process Boundaries

The application is built on Electron, Vite, and React with a strictly separated architecture. The same
renderer and main-process services also run without Electron in the multi-user **Web Server** mode:

```
┌─────────────────────────────────────────────────────────────┐
│                       Renderer Process                      │
│  React 18 · Tailwind CSS · Lucide Icons · xterm.js · Vite   │
│  UI: Dual-pane explorer, TabBar, Terminals, Modals, AI Hub  │
└──────────────────────────────┬──────────────────────────────┘
                               │ (window.multissh: MultiSSHApi)
┌──────────────────────────────▼──────────────────────────────┐
│               Preload & Web Client Bridge                   │
│  Desktop: src/preload/index.ts (contextBridge)              │
│  Browser: src/renderer/src/lib/webClientBridge.ts           │
│  Shared factory: src/shared/ipc/createMultiSSHApi.ts        │
└──────────────────────────────┬──────────────────────────────┘
                               │ (Electron IPC / WebSocket RPC)
┌──────────────────────────────▼──────────────────────────────┐
│                         Main Process                        │
│  src/main/desktopEntry.ts -> src/main/index.ts · IpcBridge  │
│  Web Server: src/main/web/serverEntry.ts · WebServer        │
│  Node.js environment: node-pty, AWS S3 SDK, fs, net, ssh CLI │
│  StorageRegistry · TransferQueue · ProfileStore (safeStorage)│
│  SSHPtyManager · AskpassServer · AgentLifecycleManager       │
│  AI Hub: src/main/ai/hub (HubService, createHub)            │
└─────────────────────────────────────────────────────────────┘
```

### Process Sandboxing & Security
- `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- The renderer has **zero** direct access to Node.js built-ins (`fs`, `child_process`, `net`).
- All communication must go through `src/shared/types/ipc.ts` and the shared `MultiSSHApi` factory in `src/shared/ipc/createMultiSSHApi.ts`. `src/preload/index.ts` passes it `ipcRenderer`; `webClientBridge.ts` passes a WebSocket transport, so both front ends expose the same API.

### Runtime Modes
- **Desktop** (`npm run dev`, `npm run build`): `src/main/desktopEntry.ts` loads `src/main/index.ts`, launching the unified sshs3 window with the built-in AI Hub.
- **Web Server** (`npm run build:web` → `dist-web/server.mjs`, `npm run start:web`): `src/main/web/serverEntry.ts` starts `WebServer` (HTTP API + RFC 6455 WebSocket RPC). `WebAuthService` handles accounts, sessions and invite links; `WebTenantManager` gives each user an isolated set of stores (profiles, K8s profiles, Team Vaults, snippets, AI Hub). `electronShim.ts` replaces the Electron APIs the main-process services import.
- **Demo mode** (`npm run demo`, `--demo` or `SSHS3_DEMO=1`): decided once at process start in `src/main/demo/demoMode.ts` and never persisted. A demo process keeps all state in its own `demo-workspace` data directory, uses `DemoVirtualPty`/`DemoStorageProvider` for the `demo-…` fixtures, and `outwardSync.ts` turns off S3 team workspace sync, Team Vault sync and remote profile sync so nothing from the demo workspace leaves the machine. Outside demo mode the AI Hub uses the neutral defaults in `src/main/ai/hub/builtins.ts`.

---

## 2. Directory Structure & Key Modules

```
├── docs/                           # Architecture, comparison, and subsystem guides
│   ├── COMPARISON.md               # Detailed comparison vs PuTTY, MobaXterm, WinSCP, S3 Browser
│   ├── ai-hub.md                   # AI Hub: runtimes, knowledge base, self-learning, safety, MCP, web/demo modes
│   └── user-guide/                 # End-user docs, published at docs.sshs3.com
├── scripts/                        # Deploy/release scripts (deploy.sh, deploy-vm.sh), build-web.mjs, docs-lint.mjs
├── src/
│   ├── main/                       # Electron main process (Node.js)
│   │   ├── desktopEntry.ts         # Electron entry: stdio guard, then index.ts
│   │   ├── index.ts                # Application lifecycle, window creation, quit hooks
│   │   ├── IpcBridge.ts            # IPC bridge: constructor/wiring, prompt layer (pending prompts, presence), auto-sync, dispose
│   │   ├── ai/                     # AI: AiConfigStore, CodexAuthProvider
│   │   │   └── hub/                # AI Hub: HubService (actions, agent tools), createHub (host wiring), HubStore, DirectAgentRuntime, KnowledgeBaseService (Orama), SelfLearningService, CommandSafetyService, ContextService, TerminalRegistry, ToolBroker, McpClientManager, S3WorkspaceSyncService, builtins/demoWorkspace, privacy
│   │   ├── demo/                   # Launch-time demo mode: demoMode, outwardSync, DemoVirtualPty, DemoStorageProvider
│   │   ├── web/                    # Multi-user Web Server: serverEntry, WebServer, WebAuthService, WebTenantManager, electronShim
│   │   ├── ipc/                    # One registerXHandlers(bridge) per domain (terminal, smartcard, storage, transfer, profile, dotfile, sync, k8s, key install, git, …) + ipcHelpers.ts
│   │   ├── aws/                    # AWS SSO OIDC device auth service (AwsSsoAuthService)
│   │   ├── ca/                     # SSH Certificate Authority: SshCaService (session, cert install, timers), oidcFlow (OIDC discovery/browser login/refresh), operationQueue, providers/ (Step-CA, Vault), cert validation, agent protocol, sshWire (wire encoding)
│   │   ├── oauth/                  # Shared OAuth/OIDC loopback callback server, PKCE, requestJson
│   │   ├── crypto/                 # System CA trust store & SecretFieldCrypto
│   │   ├── dirsync/                # Directory diff and synchronization engine
│   │   ├── dotfiles/               # Dotfiles pool store, SFTP sync & Git importer (DotfileGitImporter)
│   │   ├── editor/                 # Temporary external file editor service
│   │   ├── git/                    # Git config, commit signing, status & remote operations
│   │   ├── profile/                # OS keychain encrypted profile store (safeStorage)
│   │   ├── proxy/                  # HTTP/SOCKS socket creation & proxyCli helper
│   │   ├── search/                 # Local/remote regex search & live log tailing (tail -f)
│   │   ├── services/               # K8s discovery, debug containers, port forward, OpenShift, & Team Vault (TeamVaultService, TeamVaultCryptoService, TeamVaultConfigStore, AgeBinaryResolver, AgePtyPinRelay)
│   │   ├── session/                # Window tab & layout persistence (SessionStore)
│   │   ├── clipboard/              # Encrypted terminal selection history (ClipboardHistoryStore)
│   │   ├── snippets/               # Saved terminal command snippets (SnippetStore, plain JSON)
│   │   ├── settings/               # App configuration & default settings (SettingsStore)
│   │   ├── policy/                 # Machine policy (admin-managed settings): sources, parsing, apply
│   │   ├── update/                 # Auto-update polling & state machine (UpdateService, electron-updater)
│   │   ├── smartcard/              # PKCS#11 detection, cert parsing, isolated AskpassServer & SmartcardCoordinator (app-agent/card state and lifecycle)
│   │   ├── ssh/                    # SSH PTY manager, HostKeyVerifier, SSHTunnelManager, AgentLifecycle
│   │   │                           # (+ AppAgent: the one app-wide ssh-agent (stable socket, askpass server, lock/unlock) that holds every unlocked smartcard/FIDO2 key under Global PIN caching)
│   │   ├── storage/                # Local, SFTP, S3, and K8s Pod Storage Providers & Registry
│   │   │   └── sftp/               # OpenSSH-based SFTP engine (protocol, streams, process, adapter)
│   │   ├── terminal/               # K8s container exec PTY & live log streaming managers
│   │   ├── transfer/               # Streaming TransferPipeline, ByteMeter & TransferQueue
│   │   └── x11/                    # X11 server lifecycle manager (VcXsrv integration)
│   ├── preload/                    # Electron preload script exposing window.multissh (via shared createMultiSSHApi)
│   ├── renderer/                   # React frontend
│   │   └── src/
│   │       ├── App.tsx             # Root component: layout, top-level modals, tab views
│   │       ├── components/
│   │       │   ├── AiHub/          # AI Hub panel (chat, agents, knowledge base, memory/self-learning, MCP, safety policy) + TerminalControl
│   │       │   ├── ConnectionModal/# Profile management for SSH, S3, and Kubernetes (ConnectionManagerModal + team tabs, TeamProfileTree/List, folder/row/import components, connectionGrouping.ts)
│   │       │   ├── FileManager/    # DualPaneExplorer, FileList, FilePane (+ FilePaneToolbar, FilePaneFilterBar, FilePaneModals, GitStatusMenu, filePaneContextMenu.ts), GitCloneModal
│   │       │   ├── K8s/            # Pod inspector, port forward modal, debug container UI
│   │       │   ├── LandingView.tsx # AI workspace start page: servers/clusters, quick actions, web account settings
│   │       │   ├── SettingsModal/  # SettingsModal shell + useSettingsForm (draft state) + one *SettingsSection per category, GitSettingsPanel, SyncSettingsPanel, TeamVaultListPanel, TeamVaultDetailPanel
│   │       │   ├── TabBar.tsx      # Draggable/closable tab bar
│   │       │   ├── TerminalView.tsx# xterm.js terminal instance & FitAddon
│   │       │   ├── Tunnels/        # Independent SSH port-forwarding management dashboard
│   │       │   └── WebAuthGate.tsx # Web Server mode login, first-user setup, invite registration & SSH key setup
│   │       └── lib/
│   │           ├── aiHub.ts        # AI Hub snapshot subscription & action dispatch helpers
│   │           ├── format.ts       # Byte/speed formatting, date formatters, path utils
│   │           ├── tabs.ts         # AppTab type and tab normalisation/sanitising helpers
│   │           ├── useAppKeyboard.ts      # App-wide shortcuts, spatial Ctrl+Shift+Arrow navigation, Enter/Escape in modals
│   │           ├── useTabActions.ts       # Create/close/split/connect tabs and panes
│   │           ├── useSessionPersistence.ts # Restore and save the tab session
│   │           ├── spatialNavigation.ts # 2D keyboard navigation (Ctrl+Shift+Arrows) for panes, overlays and menus
│   │           └── webClientBridge.ts # Browser transport (HTTP + WebSocket) that builds window.multissh in Web Server mode
│   └── shared/                     # Code and types shared between main and renderer
│       ├── ipc/
│       │   └── createMultiSSHApi.ts # The one MultiSSHApi implementation, used by preload and webClientBridge
│       └── types/
│           ├── ai.ts               # AI provider/model config (DEFAULT_AI_MODELS)
│           ├── aiHub.ts            # AI Hub snapshot, actions, memory, safety policy & self-learning types
│           ├── dotfiles.ts         # Dotfiles sync pool contracts
│           ├── git.ts              # Git status, commit signing, clone & key fetching types
│           ├── ipc.ts              # IPC_CHANNELS and MultiSSHApi interface
│           ├── kubernetes.ts       # Kubernetes cluster, pod, and container exec types
│           ├── session.ts          # Tab, pane, and split layout types
│           ├── settings.ts         # AppSettings and keyboard shortcut definitions
│           ├── ssh.ts              # SSHConnectionConfig, PtyOptions, Smartcard
│           ├── storage.ts          # IStorageProvider, FileEntry, S3Config, SFTPConfig
│           ├── sync.ts             # Profile sync categories, state & comparison results
│           ├── teamVault.ts        # Team Vault config, members & sync types
│           └── tunnel.ts           # Standalone tunnel configs & lifecycle events
└── tests/                          # Unit and integration tests (Vitest)
    ├── e2e/                        # End-to-end workflow tests
    ├── main/                       # Main process tests (providers, stores, transfers)
    └── renderer/                   # React component testing (Testing Library, JSDOM)
```

---

## 3. Storage Provider Architecture (`IStorageProvider`)

All file and object interactions adhere to the `IStorageProvider` interface in [`src/shared/types/storage.ts`](src/shared/types/storage.ts):

```typescript
export interface IStorageProvider {
  readonly id: string;
  readonly name: string;
  readonly type: StorageType; // 'local' | 'sftp' | 's3' | 'k8s'

  list(remotePath: string, options?: { force?: boolean }): Promise<FileEntry[]>;
  stat(remotePath: string): Promise<FileEntry>;
  createFolder(remotePath: string): Promise<void>;
  delete(remotePath: string, isDirectory: boolean): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  createReadStream(remotePath: string, start?: number, end?: number): Promise<NodeJS.ReadableStream>;
  createWriteStream(remotePath: string, options?: WriteStreamOptions): Promise<NodeJS.WritableStream>;
  chmod?(remotePath: string, mode: number | string): Promise<void>;
  disconnect?(): Promise<void>;
}
```

### SFTP engine (`src/main/storage/sftp/`)

`SFTPStorageProvider` no longer uses a JavaScript SSH library. It drives the system OpenSSH client:

- `OpenSshSftpProcess` spawns `ssh <args from SmartcardDetector.buildSSHArguments> -o BatchMode=no -s -- [user@]host sftp` and watches stderr for touch-presence prompts. The `-s` flag makes the trailing word a *subsystem name*, so it must come after the destination. Authentication, ProxyJump, `~/.ssh/config`, FIDO2 and PKCS#11 are therefore handled by OpenSSH exactly as in the terminal.
- `AskpassServer` supplies passwords/PINs/passphrases (`SSH_ASKPASS`) and routes PIN prompts to the renderer PIN modal. OpenSSH's "continue connecting" host-key question is answered through the TOFU dialog (`hostVerifier.hostKeyPrompt`) and rejected if no handler exists (fail closed).
- `SftpPacketProtocol` implements SFTP v3 framing and request/response routing; `SftpStreams` provides `SftpReadStream`/`SftpWriteStream` with Node backpressure.
- `OpenSshSftpClientAdapter` exposes the `ssh2-sftp-client`-style surface that `SFTPStorageProvider` consumes, and provides `exec()`/`createExecStream()` for tail and remote search (multiplexed over the `ControlPath` socket, kept in a private 0700 temp directory).
- Password profiles pass `PubkeyAuthentication=no` (in `buildSSHArguments`) so a touch/PIN-protected agent key can't block the password login.

### In-Memory Streaming Pipeline
Transfers between different storage providers (e.g. SFTP -> S3, S3 -> Local, Local -> SFTP) stream directly in-memory via Node.js streams through [`TransferPipeline.ts`](src/main/transfer/TransferPipeline.ts):
- `ByteMeter` calculates speed and throttles progress events to 100ms intervals.
- `PauseController` provides pause/resume capabilities over streams without closing connections.
- Path normalization uses `joinPaths` and prevents duplicate nesting by ensuring `getBaseName(targetPath) !== baseName`.

---

## 4. How to Add a New Feature (AI Guide)

### Adding an IPC Method
1. **Define Channel & Types**:
   - Open [`src/shared/types/ipc.ts`](src/shared/types/ipc.ts).
   - Add channel constant to `IPC_CHANNELS`.
   - Add method signature to `MultiSSHApi`.
2. **Preload & Web Client Exposure**:
   - Open [`src/shared/ipc/createMultiSSHApi.ts`](src/shared/ipc/createMultiSSHApi.ts).
   - Implement the method on the returned `MultiSSHApi` object using `ipcRenderer.invoke` or `ipcRenderer.on`. Both [`src/preload/index.ts`](src/preload/index.ts) (Electron `ipcRenderer`) and [`src/renderer/src/lib/webClientBridge.ts`](src/renderer/src/lib/webClientBridge.ts) (WebSocket transport in Web Server mode) build `window.multissh` from this factory, so do not add methods to either of them directly.
3. **Main Process Implementation**:
   - Add the handler to the matching domain file in [`src/main/ipc/`](src/main/ipc/), inside its `registerXHandlers(bridge)` function, using `bridge.registerHandler(IPC_CHANNELS.MY_ACTION, async (_event, ...) => { ... })`. Services and shared state are reached through `bridge` (the [`IpcBridge`](src/main/IpcBridge.ts) instance), typed as that file's own `XHost = Pick<IpcBridge, ...>` so a group only sees the members it uses (add the member to the `Pick` when you need a new one; `tests/main/ipcHostAccess.test.ts` guards who may touch the PIN-prompt maps and agent state); `registerHandler` also runs the sender check (`assertTrustedSender`), so never call `ipcMain.handle` directly.
   - A new domain gets its own `ipc/<domain>Handlers.ts` and one call in `IpcBridge.register()` (order matters only for the existing groups).

   | Domain | File |
   |---|---|
   | Terminal sessions | `ipc/terminalHandlers.ts` |
   | Smartcard / host key / FIDO2 prompts | `ipc/smartcardHandlers.ts` |
   | Storage providers | `ipc/storageHandlers.ts` |
   | Transfers, quit confirm | `ipc/transferHandlers.ts` |
   | Native drag-out of local files | `ipc/dragOutHandlers.ts` |
   | Saved profiles | `ipc/profileHandlers.ts` |
   | Dotfile pools | `ipc/dotfileHandlers.ts` |
   | Profile sync | `ipc/syncHandlers.ts` |
   | Key install (ssh-copy-id) | `ipc/keyInstallHandlers.ts` |
   | Connection tests | `ipc/connectionTestHandlers.ts` |
   | Git | `ipc/gitHandlers.ts` |
   | AWS SSO | `ipc/awsSsoHandlers.ts` |
   | File editor / tail | `ipc/fileEditorHandlers.ts` |
   | Search | `ipc/searchHandlers.ts` |
   | Kubernetes, perf, tunnels | `ipc/k8sHandlers.ts` |
   | Directory sync | `ipc/dirSyncHandlers.ts` |
   | App, updates, X11, dialogs | `ipc/generalHandlers.ts` |
   | Session, clipboard, snippets, settings | `ipc/appDataHandlers.ts` |
   | Machine policy (read-only) | `ipc/policyHandlers.ts` |
   | SSH Certificate Authorities (SSH CA) | `ipc/sshCaHandlers.ts` |
   | Team Vaults | `ipc/teamVaultHandlers.ts` |
   | Renderer log forwarding | `ipc/logHandlers.ts` |
   | AI Hub (`HUB_CHANNEL`, one `HubRequest` union) | `IpcBridge.ts` → `bridge.aiHub` (built by `ai/hub/createHub.ts`) |
   - AI Hub features are not new IPC channels: add a variant to `HubRequest` in `shared/types/aiHub.ts`, handle it in `HubService.request()`, and give `HubService` access to host services through the `HubHost` interface implemented in `createHub.ts` (the same code serves the desktop app and every Web Server tenant).
   - State-free helpers shared by handlers live in `ipc/ipcHelpers.ts`; askpass prompt classification in `ssh/askpassPrompt.ts`.
   - The smartcard/FIDO2 agent lifecycle lives in [`SmartcardCoordinator`](src/main/smartcard/SmartcardCoordinator.ts), reached through `bridge.smartcard`. Its state (`globalCards`, the app agent, per-session agents, cooldown and in-flight maps, certificate caches, the startup-unlock promise) is private; handlers only use its methods (`prepare*Config`, `awaitStartupUnlock`, `getUnlockedCardSocket`, `isInLoadCooldown`, `appAgentSocketIfUnlocked`, `listSessionAgents`, `dispose`, …), each handler group's host type lists exactly the coordinator methods it calls (`smartcard: Pick<SmartcardCoordinator, ...>`), and `tests/main/ipcHostAccess.test.ts` fails if a handler reads that state or its `Pick` drifts from what it calls. It gets its dependencies through `SmartcardDeps` (stores, `sshPtyManager`, the PIN prompt and presence notifier, the agent-block sync callback) and never imports `IpcBridge`. The prompt layer (`promptForPinDirect`, `pendingAskpass`, `makePresenceNotifier`) and the auto-sync methods stay on `IpcBridge`.
   - **Pushing events to the renderer (multi-window):** never call `getWebContents().send` directly. Use the `IpcBridge` helpers, backed by [`WindowManager`](src/main/windows/WindowManager.ts): `sendToSession(sessionId, …)` for output bound to a terminal/log session (the window that created it, recorded with `bridge.assignSession(event.sender, sessionId)` in the create handler), `sendToSender(event.sender, …)` for progress of a request (search, dir-sync, AWS SSO), `broadcast(…)` for app-wide state (settings, sync, transfers, updates), and `sendToFocused(…)` / `getWebContents()` only for prompts that need one answer (host key, PIN, quit). Prompts keep their fail-closed fallback when no window exists.
   - **Moving a tab between windows:** the renderer sends the tab (secrets stripped, `sanitizeTabForSession`) plus the running session ids of its panes (`lib/liveSessions.ts`) with `windowMoveTab`. The source pane leaves the sessions running (`markDetached`); `WindowManager.reserve` keeps them from being ended if the old window closes. The target pane calls `terminalAttach`, which in one step makes that window the owner and returns the recent output kept per session in `ScrollbackBuffer` (replayed into the new xterm), so no output is lost or shown twice.
4. **Renderer Usage**:
   - Access via `window.multissh.myAction(...)`.

---

## 5. Coding & Formatting Conventions

- **Date Format**: Always display and persist timestamps in `yyyy-mm-dd HH:mm` (24-hour) format. Use `formatDateTime()` from [`src/renderer/src/lib/format.ts`](src/renderer/src/lib/format.ts) or `formatDate()` from [`src/main/storage/StorageProvider.ts`](src/main/storage/StorageProvider.ts).
- **Release Versioning**: Bump the patch segment by default (`0.96.6` → `0.96.7`); bump minor only for real milestones. Tag as `vX.Y.Z` and add a `CHANGELOG.md` entry in every release.
- **Security & Ephemeral Secrets**: Private keys must never leave hardware tokens. PINs and passphrases are strictly ephemeral and must never be stored on the filesystem, cached in memory, or logged in plaintext. The one deliberate exception: `AppAgent` keeps the FIDO2 PIN in process memory (`fido2Pin`) while keys are unlocked, so `verify-required` keys only need a touch per signature; it is cleared on lock/quit and never replayed after a failure (`FIDO2_PIN_REPLAY_WINDOW_MS`).
- **Pure Logic First**: New algorithms, calculations, parsing and validation rules go in pure functions in their own module (`lib/`, a utility file, `ipc/ipcHelpers.ts`) with their own Vitest tests, not inline in large components or services. Don't grow files that are already large (~800+ lines) with new responsibilities; extract a hook, sub-component or module instead. [`spatialNavigation.ts`](src/renderer/src/lib/spatialNavigation.ts) is the model.
- **Electron Fuses**: set in `electron-builder.json` (`electronFuses`). `runAsNode` must stay enabled: askpass, `certWorker.cjs`, the K8s shims and the proxy `ProxyCommand` (`proxyCli.cjs`) run through the app binary with `ELECTRON_RUN_AS_NODE=1`. `NODE_OPTIONS` and `--inspect` are disabled for the app itself and `onlyLoadAppFromAsar` is on. Verify a packaged build with `npx @electron/fuses read --app <path-to-binary>`.
- **Fast Refresh Cleanliness**: React component files should only export React components. Helper functions belong in `types.ts` or utility files, and hooks belong in dedicated files or contexts.
- **Logging**: Never use `console.*` in `src/main` (ESLint `no-console` enforces it). Use `createLogger('<scope>')` from [`src/main/log`](src/main/log/index.ts) (`error|warn|info|debug`); the renderer uses `createRendererLogger()` from `src/renderer/src/lib/log.ts`, which forwards over IPC (validated and rate-limited in `ipc/logHandlers.ts`). Every line is masked by `log/redact.ts` before it is written to `<userData>/logs/sshs3.log` (dir 0700, file 0600, 5 MB × 5 rotation). Log events and counts, never PINs, passphrases, key material or whole environments. Level: Settings → General → Logging, or `SSHS3_LOG_LEVEL` (wins). Tests capture output with `tests/main/helpers/captureLogs.ts`.
- **Fail Closed for Security**: Host key verification (TOFU) and smartcard askpass operations must default to rejecting/aborting if the UI is unmounted or unavailable.
- **Machine policy** (`src/main/policy/`, schema in `shared/types/policy.ts`): `POLICY_DEFINITIONS` is the one table that drives parsing, the registry value names, the settings UI locks and the ADMX/ADML drift test (`tests/main/policyTemplates.test.ts`). `SettingsStore.getSettings()` returns the *effective* settings (policy applied), so every caller is enforced by default; `getStoredSettings()` is the raw file and is used only by profile sync. Writes go through `readStored()` and `stripLockedKeys`, so a managed value is never written to `settings.json`. To add a policy: a table entry, its ADMX/ADML entry, and the enforcement point. See the user guide page "Enterprise Deployment".
- **Async Write Safety**: All stores (`ProfileStore`, `SessionStore`, `SettingsStore`, `DotfilePoolStore`, `ClipboardHistoryStore`, `SnippetStore`) use `queueMutation` promises to ensure sequential, atomic writes to disk.

---

## 6. Verification & Quality Commands

Always run these checks before finishing any task:
```bash
npm run typecheck   # Static typecheck with TypeScript
npm run lint        # ESLint verification (must be 0 errors, 0 warnings)
npm run test        # Unit & integration tests via Vitest
npm run build       # Verify Vite & electron-builder bundle compilation
npm run deploy      # Bump patch version, commit, tag, and push to GitHub Actions (scripts/deploy.sh)
```
