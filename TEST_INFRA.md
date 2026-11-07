# End-to-End Test Infrastructure (`TEST_INFRA.md`)
**Project**: `sshs3` — Complete UI Redesign, Hermes Eradication & Multi-Workspace Simultaneous Connectivity (`codex/ai-hub`)  
**Authoritative Spec**: `/home/antigravity/icedbug/sshs3/.agents/teamwork/ORIGINAL_REQUEST.md` & `PROJECT.md`  
**Test Framework**: Vitest 5 (`vitest run`) + React Testing Library (`@testing-library/react`, `jsdom`)  
**Suite Locations**: `tests/renderer/redesign/` & `tests/main/multiWorkspace.test.ts`

---

## 1. Feature & Locked Decision Inventory

Every requirement from the Phase 0 Survey, the 6 locked `/grill-me` user alignment decisions, and the Multi-Workspace follow-up (`"Man ska kunna vara kopplad till flera olika workspaces"`) is mapped to `F1`–`F16` below:

### Locked `/grill-me` Decisions & Follow-Up (`ORIGINAL_REQUEST.md`)
1. **Decision #1 — Application Shell & Navigation Layout (Option 1B + Omnibar)**:
   - Airy horizontal tab-centered topbar (`h-11` / 44px) with zero 40px button sprawl, central/prominent Global Command Palette / Omnibar (`Cmd+K` / `Ctrl+K`), and clean drawer triggers.
   - Replace full-screen blocking modals (`ConnectionManagerModal`, `SSHGlobalTunnelsModal`, `SettingsModal`, `DirSyncSavedProfilesModal`) with smooth slide-over side panels/drawers (Left: Connections/Inventory; Right: AI Hub / Inspector / Settings / Tunnels / DirSync).
   - Persistent bottom status bar with Global Transfer HUD.
2. **Decision #2 — Server Blades & Telemetry Integration (Option 2A + 2B Hybrid)**:
   - Dedicated "Mission Control / Fleet" start tab (`LandingView.tsx`) with Server Blades, live SVG sparklines, and topology.
   - Discreet inline Session Telemetry Pill (CPU %, latency ms, 8-point SVG sparkline, health status dot) in active session/terminal headers with 1-click detail popover expansion.
3. **Decision #3 — SSH + SFTP + File Transfers (Option 3A — Split View & Global Transfer HUD)**:
   - Split-pane capability ("Host Workspace" / Universal Pane Splitting) between SSH terminal and SFTP file browser for the same server in the same workspace tab (`PaneLeaf.leafType?: 'terminal' | 'sftp'`).
   - Global Transfer HUD in the persistent bottom status bar showing active SFTP/S3 transfers, throughput speed, and queue progress across all tabs.
4. **Decision #4 — S3 Cloud Object Storage (Option 4A — Dedicated Cloud Explorer & Inspector)**:
   - Dedicated 3-column S3 workstation: Left bucket/prefix tree, middle virtualized object table with drag-and-drop upload and storage class badges, right **S3 Inspector Panel** (object metadata, bucket metrics, CORS/policy status, object tags, version history, and 1-click presigned URL generator).
5. **Decision #5 — AI Copilot & Error Analysis (Option 6 — Ambient Terminal Co-Pilot + Side Panel)**:
   - On terminal error (non-zero exit code) or shortcut, surface a discreet floating pill `[ ⌘K Förklara & Åtgärda ]` (`data-testid="terminal-copilot-pill"`) that expands the AI Hub side panel with terminal context and `@orama/orama` RAG lookup.
   - Contextual AI actions in SFTP/S3 (`"Förklara konfigurationsdiff"`, `"Generera S3-policy"`, `"Indexera i Kunskapsbas"`).
6. **Decision #6 — Design System, Multi-Theme, Micro-Interactions & Hermes Eradication (Option 5A + 7)**:
   - Full Cyber-Clean & Multi-Theme: Convert hardcoded black/dark colors (`#060911`, `#070b13`, etc.) in `aiHub.css` and `LandingView.tsx` to semantic CSS tokens (`--bg-app`, `--bg-surface`, `--bg-card`, `--bg-glass`, `--text-primary`, `--accent-primary`, etc.) so **Dark** (`:root`), **Light** (`.light`), and **Breeze** (`.breeze`) work 100% seamlessly.
   - Polished micro-interactions: Smooth slide-over drawer animations, subtle live telemetry pulses, `backdrop-blur` glass panels, and crisp typography.
   - Complete eradication of all 18+ dead Hermes files and config references in Milestone 1 while keeping `DirectAgentRuntime.ts` and `CodexAuthProvider.ts` intact.
7. **Follow-Up #7 — Multi-Workspace Simultaneous Connectivity (`F13`–`F16`)**:
   - Simultaneous connection to multiple workspaces (S3 Team Buckets, Team Vaults, Shared Files, Demo Workspaces, and Personal Local Workspace) with isolated per-workspace server caches, provenance tagging (`workspaceId` & `workspaceName`), and unified or filtered views across `LandingView`, `BottomStatusBar`, `AiHubPanel`, and `GlobalSearchPalette` (`Cmd+K` Omnibar).

### Feature Matrix (`F1`–`F16`)

| ID | Feature | Milestone | Test File | Status |
|----|---------|-----------|-----------|--------|
| **F1** | Dead Hermes Code Eradication | M1 | `tests/renderer/redesign/m1_hermes_and_themes.test.ts` | IMPLEMENTED |
| **F2** | Multi-Theme Cyber-Clean Design System (`:root`, `.light`, `.breeze`) | M1 | `tests/renderer/redesign/m1_hermes_and_themes.test.ts` | IMPLEMENTED |
| **F3** | Micro-Interactions, Slide-Over Classes & Glassmorphism | M1 | `tests/renderer/redesign/m1_hermes_and_themes.test.ts` | IMPLEMENTED |
| **F4** | Airy Tab-Centered Topbar & Omnibar (`Cmd+K`) | M2 | `tests/renderer/redesign/m2_topbar_drawers_statusbar.test.tsx` | IMPLEMENTED |
| **F5** | Slide-Over Side Panels / Drawers (`SlideOverDrawer.tsx`) | M2 | `tests/renderer/redesign/m2_topbar_drawers_statusbar.test.tsx` | IMPLEMENTED |
| **F6** | Persistent Bottom Status Bar & Global Transfer HUD | M2 | `tests/renderer/redesign/m2_topbar_drawers_statusbar.test.tsx` | IMPLEMENTED |
| **F7** | Hybrid Server Blades & Session Telemetry Pill | M3 | `tests/renderer/redesign/m3_telemetry_and_host_split.test.tsx` | IMPLEMENTED |
| **F8** | SSH + SFTP Split View (Host Workspace) | M3 | `tests/renderer/redesign/m3_telemetry_and_host_split.test.tsx` | IMPLEMENTED |
| **F9** | Dedicated S3 Cloud Explorer & Inspector | M4 | `tests/renderer/redesign/m4_s3_inspector_and_ai_actions.test.tsx` | IMPLEMENTED |
| **F10** | Ambient Terminal Co-Pilot Pill (`[ ⌘K Förklara & Åtgärda ]`) | M4 | `tests/renderer/redesign/m4_s3_inspector_and_ai_actions.test.tsx` | IMPLEMENTED |
| **F11** | Contextual SFTP/S3 AI Actions | M4 | `tests/renderer/redesign/m4_s3_inspector_and_ai_actions.test.tsx` | IMPLEMENTED |
| **F12** | Full Verification, Demo Visual Check (`SSHS3_DEMO=1`) & Git Push | M5 | `tests/renderer/redesign/e2e_tiers3_and_4_workflows.test.tsx` | IMPLEMENTED |
| **F13** | Multi-Workspace Backend Registry & Simultaneous S3/Vault/File Sync | M6 | `tests/main/multiWorkspace.test.ts` | IMPLEMENTED |
| **F14** | Mission Control Multi-Workspace Hub, Filter Pills & Simultaneous Connection UI | M6 | `tests/renderer/redesign/m5_multi_workspace.test.tsx` | IMPLEMENTED |
| **F15** | Cross-App Multi-Workspace Switcher & Omnibar / StatusBar / AI Hub Integration | M6 | `tests/renderer/redesign/m5_multi_workspace.test.tsx` | IMPLEMENTED |
| **F16** | Multi-Workspace Tiers 1–4 Unit & E2E Test Suite + Demo Verification | M6 | `tests/main/multiWorkspace.test.ts` & `tests/renderer/redesign/m5_multi_workspace.test.tsx` | IMPLEMENTED |

---

## 2. Four-Tier Test Design Methodology

To guarantee requirement-driven verification and prevent facade tests, all tests in `tests/renderer/redesign/` and `tests/main/multiWorkspace.test.ts` are structured across four progressive tiers:

### Tier 1: Feature Coverage
- Exercises the primary behavioral contracts for each feature `F1`–`F16`.
- Verifies exact DOM structure, semantic token bindings, file system invariants, multi-workspace slot registries, state transitions, and IPC / CustomEvent payloads.

### Tier 2: Boundary & Corner Cases
- Tests empty states (0 tabs, 0 active transfers, empty S3 buckets, undefined/empty `hub.workspaces`), selective single-workspace disconnection (`remove: true`) while preserving sibling workspaces, demo-mode outward sync blocking (`assertOutwardSyncAllowed`), extreme values (100% CPU telemetry spike, out-of-range sparklines), and reduced motion media queries (`prefers-reduced-motion: reduce`).

### Tier 3: Cross-Feature Combinations
- Verifies interaction contracts across features:
  - **F2 + F3 + F5**: Multi-theme switching (`Dark` → `Light` → `Breeze`) while `SlideOverDrawer` and `AiHubPanel` are open.
  - **F4 + F5**: Triggering drawer transitions from both the Topbar buttons and the `Cmd+K` Omnibar (`GlobalSearchPalette`).
  - **F6 + F8**: Running active SFTP/S3 transfers visible in `BottomStatusBar` (`GlobalTransferHud`) while splitting an SSH terminal into an SFTP Host Workspace.
  - **F7 + F8 + F10**: Clicking "Split SFTP" or "Diagnose with AI" from `SessionTelemetryPill` inside an active Host Workspace tab.
  - **F9 + F11**: Selecting an S3 bucket/object in `S3CloudExplorer`, inspecting metadata in `S3InspectorPanel`, and invoking `"Generera S3-policy"` or `"Indexera i Kunskapsbas"` into `AiHubPanel`.
  - **F14 + F15 + F2 + F4 + F5 + F6**: Synchronizing workspace selection across `BottomStatusBar` (`status-workspaces-badge` & `status-workspaces-popover`), `LandingView` (`multi-workspace-bar`), `AiHubPanel` (`ai-hub-workspaces-bar`), and `GlobalSearchPalette` (`omnibar-workspaces-bar`) across Dark, Light, and Breeze themes.

### Tier 4: Real-World Application Scenarios (End-to-End Workflows)
- Simulates realistic operator journeys from start to finish:
  1. **Scenario A (Fleet Incident Triage)**: Operator starts on Mission Control (`LandingView`), inspects a high-latency Server Blade in Light theme, connects to SSH, encounters a non-zero exit code, clicks `[ ⌘K Förklara & Åtgärda ]` (`F10`), and receives Orama RAG runbook guidance in the right AI Hub drawer.
  2. **Scenario B (Host Workspace Live Config Fix)**: Operator opens an SSH session, clicks the header `SessionTelemetryPill` (`F7`) to split the pane with SFTP (`F8`), diffs a remote config file (`"Förklara konfigurationsdiff"`, `F11`), and monitors background upload progress in the persistent `GlobalTransferHud` (`F6`).
  3. **Scenario C (Cloud Object Governance)**: Operator opens an S3 connection in `S3CloudExplorer` (`F9`), navigates the bucket/prefix tree, inspects object tags/versions and generates a 1-click presigned URL in `S3InspectorPanel`, then triggers `"Generera S3-policy"` (`F11`).
  4. **Scenario D (Multi-Workspace Fleet Operations — `F13`–`F16`)**: Operator is simultaneously connected to 3 workspaces (`Stockholm Core Storage`, `StorageGRID & Cloud S3`, `K8s & Ceph Platform`), filters to `StorageGRID & Cloud S3` on Mission Control, connects a 4th workspace (`DR Vault Frankfurt`) via `+ Connect Workspace` (`mode: 'add'`), switches back to `ALL` via `BottomStatusBar` (`status-workspaces-badge`), and triggers `Sync All Connected Workspaces` via the `Cmd+K` Omnibar.

---

## 3. Detailed Test Specifications for Milestone 6 (`F13`–`F16`)

### Backend Multi-Workspace Suite: `tests/main/multiWorkspace.test.ts` (ACTIVE — 7 Tests)
- `F13.1`: Connects 3 S3 workspaces simultaneously (`ws-prod`, `ws-staging`, `ws-dr`) via direct config and `sshs3-s3://` invite codes (`mode: 'add'`), verifying `s3Workspace.getWorkspacesStatus()`, `hub.snapshot().workspaces`, and the 2-timer (`pollTimer` + `presenceTimer`) invariant (`vi.getTimerCount() === 2`).
- `F13.2`: Tags and merges `workspaceServers`, `memories`, `activityLog`, and `presence` with `workspaceId` and `workspaceName` across all 3 simultaneously connected workspaces without overwriting each other.
- `F13.3`: Switches `activeWorkspaceId` via `workspace-select` (`'ALL'` vs specific workspace ID) and persists across `snapshot()` calls.
- `F13.4`: Aggregates unlocked Team Vault workspaces (`vault:<id>` with `teamVaultProfileRef`) alongside connected S3 workspaces.
- `F13.5` (Tier 2): Disconnecting `ws-staging` with `remove: true` removes only `ws-staging` and its synced servers while `ws-prod` and `ws-dr` remain connected with their servers intact.
- `F13.6` (Tier 2): Upserting a server (`server-upsert`) or saving a memory (`memory-save`) targeted at a specific `workspaceId` routes and tags it exclusively to that workspace.
- `F13.7` (Tier 2): Demo mode (`setDemoModeForTesting(true)`) seeds 3 connected demo workspaces (`ws-demo-ontap`, `ws-demo-s3-grid`, `ws-demo-k8s-ceph`), `workspace-connect-demo` adds a 4th connected demo workspace, and outward S3 sync remains strictly blocked (`syncDisabledReason`).

### Renderer & E2E Multi-Workspace Suite: `tests/renderer/redesign/m5_multi_workspace.test.tsx` (ACTIVE — 11 Tests)
- `F14.1` (Tier 1): `LandingView` renders `multi-workspace-bar` with `workspace-pill-ALL`, individual pills (`workspace-pill-${ws.id}`) for 3 simultaneously connected workspaces, server counts, kind badges, per-workspace sync (`workspace-sync-${ws.id}`), per-workspace disconnect (`workspace-disconnect-${ws.id}`), and `workspace-sync-all-btn`.
- `F14.2` (Tier 1): Server Blade cards (`blade-card-${s.id}`) display `blade-workspace-badge-${s.id}` with the workspace name and preserve `teamVaultProfileRef` when connecting to a Team Vault server.
- `F14.3` (Tier 1): Clicking `workspace-pill-ws-demo-s3-grid` filters displayed Server Blades to only that workspace's nodes and dispatches `workspace-select`; clicking `workspace-pill-ALL` restores the unified fleet view across all connected workspaces.
- `F14.4` (Tier 1): Connecting an additional workspace via `workspace-add-connection-btn` -> `s3-workspace-name-input` -> `s3-save-connect-btn` sends `mode: 'add'` and keeps existing workspaces connected.
- `F14.5` (Tier 1): `+ Add Node` (`add-cluster-node-btn`) renders `add-node-workspace-select` and submits the selected `workspaceId` and `workspaceName`.
- `F14.6` (Tier 2): Disconnecting a single workspace via `workspace-disconnect-${ws.id}` calls `workspace-s3-disconnect` with `{ workspaceId: ws.id, remove: true }` and removes its servers while keeping other connected workspaces active.
- `F14.7` (Tier 2): Graceful rendering when `hub.workspaces` is empty/undefined while preserving keyboard focus order.
- `F15.1` (Tier 3): `BottomStatusBar` `status-workspaces-badge` opens `status-workspaces-popover`, switches active workspace across `BottomStatusBar` and `LandingView`, and preserves `status-connection-indicator` text (`Mission Control · Fleet Ready`).
- `F15.2` (Tier 3): `AiHubPanel` renders `ai-hub-workspaces-bar` (`ai-hub-workspace-pill-ALL`, `ai-hub-workspace-pill-${ws.id}`), synchronizing workspace selection across the app.
- `F15.3` (Tier 3): `GlobalSearchPalette` (`Cmd+K` Omnibar) surfaces `omnibar-workspaces-bar` (`omnibar-workspace-ALL`, `omnibar-workspace-${ws.id}`, `omnibar-workspace-sync-all`) and executes 1-click workspace switching across Dark, Light, and Breeze themes.
- `F16.1` (Tier 4): End-to-end operator workflow across 4 simultaneously connected workspaces using `LandingView`, S3 Connect (`mode: 'add'`), `BottomStatusBar`, and `GlobalSearchPalette`.

---

## 4. How to Run the Redesign & Multi-Workspace E2E Test Suite

```bash
# Run all Multi-Workspace & UI Redesign E2E verification tests:
npx vitest run tests/main/multiWorkspace.test.ts tests/renderer/redesign/

# Run ESLint verification on the test suites:
npx eslint tests/main/multiWorkspace.test.ts tests/renderer/redesign/

# Run full project typecheck and test suite:
npx tsc --noEmit
npm test
```
