# Project: sshs3 — Complete UI Redesign & Hermes Eradication (`codex/ai-hub`)

## Architecture
- **Frontend Stack**: React 18, TypeScript 5.7, Vite 8, Tailwind CSS v4 (`@theme` semantic tokens), `@xterm/xterm` 5.5, CodeMirror 6, `@tanstack/react-virtual`.
- **Backend / Main Process**: Electron 45 / Web Server (`dist-web/server.mjs` with `SSHS3_DEMO=1`), `DirectAgentRuntime.ts` (native TypeScript LLM tool-calling engine), `KnowledgeBaseService.ts` (`@orama/orama` BM25 + 14-dim semantic vector hybrid RAG), `SFTPStorageProvider.ts`, `S3StorageProvider.ts`, `TransferPipeline.ts`.
- **Shell Topology (Option 1B + Omnibar + Slide-Over Drawers + Bottom Status Bar)**:
  - **Top Bar (`h-11` / 44px, airy horizontal tab-centered bar)**: Brand / Mission Control Home tab trigger, scrollable Workspace Tabs (with inline Session Telemetry Pill on active sessions), central/prominent Global Command Palette / Omnibar trigger (`Cmd+K` / `Ctrl+K`), and clean left/right slide-over drawer triggers (Left: Connections & Inventory; Right: AI Hub / Inspector / Settings / Tunnels / DirSync).
  - **Slide-Over Drawers**: Smooth CSS-transitioned drawers (`backdrop-blur-md`, semantic surface tokens) replacing disruptive full-screen blocking modals for Connection Manager, SSH Tunnels, Directory Sync, Settings, and AI Hub.
  - **Main Stage**:
    - **Mission Control / Fleet Home Tab (`LandingView.tsx`)**: Full fleet overview with Server Blades, live SVG sparklines, cluster topology, KPI ribbon, and Orama RAG search.
    - **Host Workspace / Universal Split Panes (`PaneTree.tsx`)**: Supports splitting the workspace between SSH Terminal (`TerminalView`) and SFTP File Browser (`DualPaneExplorer` / `FilePane`) for the same server side-by-side in a single tab.
    - **Dedicated S3 Cloud Explorer & Inspector (`S3CloudExplorer.tsx`, `S3InspectorPanel.tsx`)**: 3-column cloud storage workstation: Left bucket/prefix tree, middle virtualized object table with drag-and-drop upload, right S3 Inspector Panel (object metadata, bucket metrics, CORS/policy, object tags, version history, and 1-click presigned URL generator).
  - **Persistent Bottom Status Bar & Global Transfer HUD (`BottomStatusBar.tsx`, `GlobalTransferHud.tsx`)**: Always-visible bottom status bar showing active connection status, smartcard/CA state, theme selector (Dark / Light / Breeze), and a live Global Transfer HUD with expandable transfer queue drawer visible across all tabs.

## Feature Inventory
Every feature from the Phase 0 Survey and locked `/grill-me` alignment is assigned to a milestone below:

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Dead Hermes Code Eradication | Delete 18+ dead Hermes files (`HermesManager.ts`, `src/main/ai/desktop/*`, `nativeHermes.ts`, `integrations/hermes-desktop/`, `scripts/hermes/`, `tests/hermes/`, dead tests) & clean 13+ config/source files while keeping `DirectAgentRuntime.ts` & `CodexAuthProvider.ts` | M1 | survey + `/grill-me` #6 |
| F2 | Multi-Theme Cyber-Clean Design System | Refactor hardcoded dark colors in `aiHub.css` and `LandingView.tsx` to semantic CSS tokens (`--bg-app`, `--bg-surface`, `--bg-card`, `--text-primary`, `--color-accent`, etc.) for 100% seamless Dark, Light, and Breeze themes | M1 | survey + `/grill-me` #6 |
| F3 | Micro-Interactions & Glassmorphism | Smooth slide-over drawer animations, subtle live telemetry pulses, `backdrop-blur` glass panels, and crisp typography | M1 | `/grill-me` #6 |
| F4 | Airy Tab-Centered Topbar & Omnibar | Replace crowded 40px header button sprawl with clean horizontal tab bar, Omnibar (`Cmd+K`), and sleek drawer toggles | M2 | survey + `/grill-me` #1 |
| F5 | Slide-Over Side Panels / Drawers | Convert Connection Manager, Tunnels, Settings, and DirSync from blocking full-screen modals into smooth slide-over left/right drawers | M2 | survey + `/grill-me` #1 |
| F6 | Persistent Bottom Status Bar & Global Transfer HUD | Persistent bottom bar with Global Transfer HUD showing active SFTP/S3 transfers and queue progress across all tabs | M2 | survey + `/grill-me` #1 & #3 |
| F7 | Hybrid Server Blades & Session Telemetry Pill | Dedicated Mission Control / Fleet home tab + discreet live CPU/latency SVG sparkline pill in active session/terminal tab headers with 1-click detail expansion | M3 | survey + `/grill-me` #2 |
| F8 | SSH + SFTP Split View (Host Workspace) | Split pane capability between SSH terminal and SFTP file browser for the same server in the same workspace tab | M3 | survey + `/grill-me` #3 |
| F9 | Dedicated S3 Cloud Explorer & Inspector | 3-pane S3 Cloud interface: left bucket/prefix tree, middle virtualized object table with drag-and-drop, right S3 Inspector Panel (metadata, metrics, CORS/policy, tags, versions, 1-click presigned URL) | M4 | survey + `/grill-me` #4 |
| F10 | Ambient Terminal Co-Pilot Pill | On terminal error (non-zero exit code) or shortcut, show floating pill `[ ⌘K Förklara & Åtgärda ]` expanding AI Hub side panel with terminal context & Orama RAG | M4 | survey + `/grill-me` #5 |
| F11 | Contextual SFTP/S3 AI Actions | Contextual AI actions in SFTP/S3 ("Förklara konfigurationsdiff", "Generera S3-policy", "Indexera i Kunskapsbas") wired to AI Hub & Orama | M4 | survey + `/grill-me` #5 |
| F12 | Full Verification, Demo Visual Check & Git Push | `vitest`, `tsc --noEmit`, `npm run build:web`, `SSHS3_DEMO=1` visual verification, and git push to `origin/codex/ai-hub` | M5 | `/grill-me` #7 |
| F13 | Multi-Workspace Backend Registry & Simultaneous S3/Vault/File Sync | Upgrade `S3WorkspaceSyncService`, `HubStore`, `HubService`, `createHub`, and `demoWorkspace` from single-workspace to multi-workspace slot registry (`workspaces`, `s3Workspaces`, `activeWorkspaceId`), keeping multiple workspaces connected and syncing simultaneously while tagging servers, memories, activity, and presence with `workspaceId` & `workspaceName` | M6 | user follow-up 2026-11-07 |
| F14 | Mission Control Multi-Workspace Hub, Filter Pills & Simultaneous Connection UI | Enhance `LandingView.tsx` with a Multi-Workspace Connection Hub showing all simultaneously connected workspaces (S3 buckets, Team Vaults, Shared Files, Demo Workspaces), workspace filter pills (`ALL` + per-workspace pills with live status, server counts, per-workspace sync & disconnect, and `"Sync All"`), `"Connect Additional Workspace"` mode in S3/Team setup, and target workspace selector in `+ Add Node` | M6 | user follow-up 2026-11-07 |
| F15 | Cross-App Multi-Workspace Switcher & Omnibar / StatusBar / AI Hub Integration | Add `data-testid="status-workspaces-badge"` interactive workspace switcher/status pill in `BottomStatusBar.tsx`, workspace filter/scope badges in `AiHubPanel.tsx`, and multi-workspace switch/sync/connect commands in `GlobalSearchPalette.tsx` (Omnibar `⌘K`) | M6 | user follow-up 2026-11-07 |
| F16 | Multi-Workspace Tiers 1–4 Unit & E2E Test Suite + Demo Verification | Comprehensive backend unit tests (`tests/main/multiWorkspace.test.ts`) and renderer E2E tests (`tests/renderer/redesign/m5_multi_workspace.test.tsx`) across Tiers 1–4 with 100% backward compatibility across all 214 existing test files | M6 | user follow-up 2026-11-07 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|--------------|--------|
| M1 | Hermes Eradication & Multi-Theme Design System | F1, F2, F3 + `PROJECT.md` at project root | none | DONE |
| M2 | Tab-Centered Shell, Omnibar, Slide-Over Drawers & Global Transfer HUD | F4, F5, F6 | M1 | DONE |
| M3 | Hybrid Telemetry Pill & SSH+SFTP Host Workspace Split View | F7, F8 | M1, M2 | DONE |
| M4 | Dedicated S3 Cloud Explorer & Inspector + Ambient AI Co-Pilot & Storage AI | F9, F10, F11 | M1, M2 | DONE |
| E2E | E2E Testing Track | Requirement-driven test suite across Tiers 1-4 (`TEST_INFRA.md`, `TEST_READY.md`) | M1 | DONE |
| M5 | Final E2E Pass, Visual Verification (`SSHS3_DEMO=1`) & Git Push | F12 + Tier 5 Adversarial Coverage Hardening | M1, M2, M3, M4, E2E | DONE |
| M6 | Multi-Workspace Simultaneous Connections, Management & Switching | F13, F14, F15, F16 | M1–M5 | DONE |

## Interface Contracts

### 1. Theme & Design Tokens (`src/renderer/src/index.css` ↔ `aiHub.css`, `LandingView.tsx`, Drawers)
- Semantic CSS variables defined on `:root` (Dark), `.light` (Light), and `.breeze` (Breeze):
  - `--bg-app`, `--bg-surface`, `--bg-surface-subtle`, `--bg-surface-hover`, `--bg-card`, `--bg-input`, `--bg-glass`
  - `--border-divider`, `--border-subtle`, `--border-strong`
  - `--text-primary`, `--text-secondary`, `--text-muted`
  - `--accent-primary`, `--accent-hover`
- Utility classes: `.sshs3-slide-drawer-left`, `.sshs3-slide-drawer-right`, `.sshs3-status-bar`, `.sshs3-telemetry-pill`, `.sshs3-copilot-pill`.

### 2. Slide-Over Drawer State & Omnibar (`App.tsx` ↔ `TabBar.tsx`, `SlideOverDrawer.tsx`, `GlobalSearchPalette.tsx`)
- Drawer types: `'connections' | 'tunnels' | 'dirsync' | 'settings' | 'ai' | null`
- Left drawer: Connections & Inventory (`ConnectionManagerModal` rendered in slide-over drawer mode)
- Right drawers: AI Hub (`AiHubPanel`), Settings (`SettingsModal`), Tunnels (`SSHGlobalTunnelsModal`), DirSync (`DirSyncSavedProfilesModal`).

### 3. Global Transfer HUD (`App.tsx` ↔ `BottomStatusBar.tsx`, `GlobalTransferHud.tsx`, `TransferQueueDrawer.tsx`)
- Subscribes to `window.multissh.onTransferProgress` / `transferList` globally at the `App.tsx` level so active transfers, speed (MB/s), and completion percentages are always visible in `BottomStatusBar` regardless of active tab, with 1-click toggle to open `TransferQueueDrawer`.

### 4. Host Workspace Split View & Session Telemetry Pill (`PaneTree.tsx`, `src/shared/types/session.ts`, `SessionTelemetryPill.tsx`)
- `PaneLeaf` supports `leafType?: 'terminal' | 'sftp'` (default `'terminal'`), allowing a single host workspace tab to split horizontally/vertically between an SSH terminal and an SFTP `FilePane` / `DualPaneExplorer` connected to the same `SSHConnectionConfig`.
- `SessionTelemetryPill`: Displays live CPU %, latency (ms), 8-point SVG sparkline, and health status dot in the active session header; clicking expands a rich telemetry popover/card with "Split SFTP", "Diagnose with AI", and "Open Fleet Tab".

### 5. S3 Cloud Explorer & Inspector (`S3CloudExplorer.tsx`, `S3InspectorPanel.tsx` ↔ `DualPaneExplorer.tsx` / `FilePane.tsx`)
- When browsing an S3 connection (`source.type === 's3'`), renders or toggles into the dedicated 3-column S3 Cloud Explorer:
  - Left column: Bucket & prefix tree browser
  - Center column: Virtualized object table with drag-and-drop upload and storage class badges
  - Right column: `S3InspectorPanel` showing object metadata, bucket metrics, CORS/policy status, object tags (`s3GetTags`/`s3PutTags`), version history (`s3ListVersions`), and 1-click Presigned URL generator (`s3GetPresignedUrl`).

### 6. Ambient Terminal Co-Pilot & Storage AI Actions (`TerminalView.tsx`, `FilePane.tsx` ↔ `AiHubPanel.tsx`)
- Non-zero exit code detection in `TerminalView.tsx` surfaces floating pill `[ ⌘K Förklara & Åtgärda ]` (`data-testid="terminal-copilot-pill"`). Clicking dispatches `sshs3:ai-open` with terminal buffer context and triggers Orama RAG lookup.
- SFTP/S3 context menu & toolbar provide AI actions: `"Förklara konfigurationsdiff"`, `"Generera S3-policy"`, and `"Indexera i Kunskapsbas"`.

### 7. Multi-Workspace Simultaneous Connectivity (`src/shared/types/aiHub.ts`, `S3WorkspaceSyncService.ts`, `HubService.ts`, `LandingView.tsx`, `AiHubPanel.tsx`, `BottomStatusBar.tsx`, `GlobalSearchPalette.tsx`)
- **Shared Types (`src/shared/types/aiHub.ts` & `src/shared/types/teamVault.ts`)**:
  - `WorkspaceServerSummary`, `MemoryEntry`, `WorkspaceMemoryEntry`, `WorkspaceActivityEvent`, and `WorkspacePresenceEntry` include optional `workspaceId?: string`, `workspaceName?: string`, and (on `WorkspaceServerSummary`) `teamVaultProfileRef?: { vaultId: string; profileId: string }`.
  - `S3WorkspaceConfig` & `S3WorkspaceSyncStatus` include optional `id?: string`, `name?: string`, `serverCount?: number`, `memoryCount?: number`, `presenceCount?: number`.
  - `ConnectedWorkspaceSummary`: `{ id: string; name: string; kind: 's3' | 'team-vault' | 'shared-file' | 'demo' | 'personal'; connected: boolean; syncing?: boolean; badge?: string; endpointOrPath?: string; bucket?: string; prefix?: string; region?: string; accessKeyId?: string; lastSyncAt?: number; error?: string; inviteCode?: string; serverCount: number; memoryCount: number; presenceCount: number }`.
  - `HubSnapshot` keeps `s3Workspace?: S3WorkspaceSyncStatus` (primary/active S3 workspace for 100% backward compatibility) and adds `s3Workspaces?: S3WorkspaceSyncStatus[]`, `workspaces?: ConnectedWorkspaceSummary[]`, and `activeWorkspaceId?: string` (default `'ALL'`).
  - `HubRequest` extends `workspace-s3-configure` (`workspaceId?: string`, `mode?: 'add' | 'update' | 'replace'`), `workspace-s3-sync-now` (`workspaceId?: string`), `workspace-s3-disconnect` (`workspaceId?: string`, `remove?: boolean`), and adds `{ action: 'workspace-select'; workspaceId: string }` and `{ action: 'workspace-connect-demo'; name: string; cluster?: string }`.
- **Backend Invariants (`S3WorkspaceSyncService.ts`, `HubStore.ts`, `HubService.ts`)**:
  - `S3WorkspaceSyncService` manages multiple simultaneous workspace slots (`Map<string, WorkspaceRuntimeSlot>`) while keeping **exactly 2 timers** (`pollTimer` and `presenceTimer`) in `startTimers()` (`vi.getTimerCount() === 2`) and persisting both top-level primary slot fields and `workspaces: StoredWorkspaceSlot[]` in `s3-workspace.json`.
  - `HubStore` isolates synced servers per workspace in `s3SyncedServersByWorkspace: Record<string, WorkspaceServerSummary[]>` and computes `s3SyncedServers` as their union so connecting/syncing Workspace B never overwrites Workspace A, and disconnecting Workspace A removes only Workspace A's transient servers.
  - `demoWorkspace.ts` seeds 3 simultaneously connected demo workspaces (`ws-demo-ontap` "Stockholm Core Storage", `ws-demo-s3-grid` "StorageGRID & Cloud S3", `ws-demo-k8s-ceph` "K8s & Ceph Platform") in `snap.workspaces` when `isDemoMode()` is active while keeping `S3WorkspaceSyncService` outward-sync guards (`demoOutwardSync.test.ts`) 100% intact.
- **Renderer `data-testid` Contracts**:
  - `LandingView.tsx`:
    - Preserves focus order (`recent-connect-r1` first when `recentSSH` non-empty; `workspace-demo-lab-toggle` first when `recentSSH` empty) and all legacy `s3-*` test IDs.
    - Adds `data-testid="multi-workspace-bar"`, `data-testid="workspace-pill-ALL"`, `data-testid="workspace-pill-${ws.id}"`, `data-testid="workspace-sync-${ws.id}"`, `data-testid="workspace-disconnect-${ws.id}"`, `data-testid="workspace-sync-all-btn"`, `data-testid="workspace-add-connection-btn"`, `data-testid="s3-workspace-name-input"`, and per-blade `data-testid="blade-workspace-badge-${s.id}"`.
  - `BottomStatusBar.tsx`:
    - Preserves `data-testid="status-connection-indicator"` text and adds `data-testid="status-workspaces-badge"` with a popover/switcher (`data-testid="status-workspaces-popover"`) to view/switch/sync connected workspaces from any tab.
  - `AiHubPanel.tsx`:
    - Displays active/connected workspaces bar (`data-testid="ai-hub-workspaces-bar"`) allowing switching workspace scope or viewing unified multi-workspace context.
  - `GlobalSearchPalette.tsx`:
    - Surfaces connected workspaces (`omnibar-workspace-${ws.id}` and `omnibar-workspace-ALL`) for instant keyboard switching and syncing.

## Code Layout
- `src/main/` — Electron main process & backend services (`DirectAgentRuntime.ts`, `HubService.ts`, `KnowledgeBaseService.ts`, `S3StorageProvider.ts`, `SFTPStorageProvider.ts`)
- `src/shared/` — Shared TypeScript interfaces (`ai.ts`, `aiHub.ts`, `ipc.ts`, `session.ts`, `storage.ts`)
- `src/renderer/src/` — React frontend (`App.tsx`, `index.css`, `components/`, `lib/`)
- `tests/` — Vitest unit and integration tests (`tests/main/`, `tests/renderer/`)

