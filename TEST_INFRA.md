# End-to-End Test Infrastructure (`TEST_INFRA.md`)
**Project**: `sshs3` — Complete UI Redesign & Hermes Eradication (`codex/ai-hub`)  
**Authoritative Spec**: `/home/antigravity/icedbug/sshs3/.agents/teamwork/ORIGINAL_REQUEST.md` & `PROJECT.md`  
**Test Framework**: Vitest 5 (`vitest run`) + React Testing Library (`@testing-library/react`, `jsdom`)  
**Suite Location**: `tests/renderer/redesign/`

---

## 1. Feature & Locked Decision Inventory

Every requirement from the Phase 0 Survey and the 6 locked `/grill-me` user alignment decisions is mapped to `F1`–`F12` below:

### Locked `/grill-me` Decisions (`ORIGINAL_REQUEST.md`)
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

### Feature Matrix (`F1`–`F12`)

| ID | Feature | Milestone | Test File in `tests/renderer/redesign/` | Status |
|----|---------|-----------|-----------------------------------------|--------|
| **F1** | Dead Hermes Code Eradication | M1 | `m1_hermes_and_themes.test.ts` | IMPLEMENTED |
| **F2** | Multi-Theme Cyber-Clean Design System (`:root`, `.light`, `.breeze`) | M1 | `m1_hermes_and_themes.test.ts` | IMPLEMENTED |
| **F3** | Micro-Interactions, Slide-Over Classes & Glassmorphism | M1 | `m1_hermes_and_themes.test.ts` | IMPLEMENTED |
| **F4** | Airy Tab-Centered Topbar & Omnibar (`Cmd+K`) | M2 | `m2_shell_drawers_and_hud.test.tsx` | PLANNED (M2) |
| **F5** | Slide-Over Side Panels / Drawers (`SlideOverDrawer.tsx`) | M2 | `m2_shell_drawers_and_hud.test.tsx` | PLANNED (M2) |
| **F6** | Persistent Bottom Status Bar & Global Transfer HUD | M2 | `m2_shell_drawers_and_hud.test.tsx` | PLANNED (M2) |
| **F7** | Hybrid Server Blades & Session Telemetry Pill | M3 | `m3_telemetry_and_host_split.test.tsx` | PLANNED (M3) |
| **F8** | SSH + SFTP Split View (Host Workspace) | M3 | `m3_telemetry_and_host_split.test.tsx` | PLANNED (M3) |
| **F9** | Dedicated S3 Cloud Explorer & Inspector | M4 | `m4_s3_inspector_and_copilot.test.tsx` | PLANNED (M4) |
| **F10** | Ambient Terminal Co-Pilot Pill (`[ ⌘K Förklara & Åtgärda ]`) | M4 | `m4_s3_inspector_and_copilot.test.tsx` | PLANNED (M4) |
| **F11** | Contextual SFTP/S3 AI Actions | M4 | `m4_s3_inspector_and_copilot.test.tsx` | PLANNED (M4) |
| **F12** | Full Verification, Demo Visual Check (`SSHS3_DEMO=1`) & Git Push | M5 | Full Suite (`npx vitest run tests/renderer/redesign/`) | PLANNED (M5) |

---

## 2. Four-Tier Test Design Methodology

To guarantee requirement-driven verification and prevent facade tests, all tests in `tests/renderer/redesign/` are structured across four progressive tiers:

### Tier 1: Feature Coverage (>= 5 Test Cases per Feature)
- Exercises the primary behavioral contracts for each feature `F1`–`F11`.
- Verifies exact DOM structure, semantic token bindings, file system invariants, state transitions, and IPC / CustomEvent payloads.

### Tier 2: Boundary & Corner Cases
- Tests empty states (0 tabs, 0 active transfers, empty S3 buckets, 0 server blades), extreme values (100% CPU telemetry spike, multi-gigabyte S3 object sizes, rapid drawer switching), reduced motion media queries (`prefers-reduced-motion: reduce`), and missing optional profile fields.

### Tier 3: Cross-Feature Combinations
- Verifies interaction contracts across features:
  - **F2 + F3 + F5**: Multi-theme switching (`Dark` → `Light` → `Breeze`) while `SlideOverDrawer` and `AiHubPanel` are open.
  - **F4 + F5**: Triggering drawer transitions from both the Topbar buttons and the `Cmd+K` Omnibar (`GlobalSearchPalette`), ensuring mutually exclusive drawer states or clean stacking.
  - **F6 + F8**: Running active SFTP/S3 transfers visible in `BottomStatusBar` (`GlobalTransferHud`) while splitting an SSH terminal into an SFTP Host Workspace.
  - **F7 + F8 + F10**: Clicking "Split SFTP" or "Diagnose with AI" from `SessionTelemetryPill` inside an active Host Workspace tab.
  - **F9 + F11**: Selecting an S3 bucket/object in `S3CloudExplorer`, inspecting metadata in `S3InspectorPanel`, and invoking `"Generera S3-policy"` or `"Indexera i Kunskapsbas"` into `AiHubPanel`.

### Tier 4: Real-World Application Scenarios (End-to-End Workflows)
- Simulates realistic operator journeys from start to finish:
  1. **Scenario A (Fleet Incident Triage)**: Operator starts on Mission Control (`LandingView`), inspects a high-latency Server Blade in Light theme, connects to SSH, encounters a non-zero exit code, clicks `[ ⌘K Förklara & Åtgärda ]` (`F10`), and receives Orama RAG runbook guidance in the right AI Hub drawer.
  2. **Scenario B (Host Workspace Live Config Fix)**: Operator opens an SSH session, clicks the header `SessionTelemetryPill` (`F7`) to split the pane with SFTP (`F8`), diffs a remote config file (`"Förklara konfigurationsdiff"`, `F11`), and monitors background upload progress in the persistent `GlobalTransferHud` (`F6`).
  3. **Scenario C (Cloud Object Governance)**: Operator opens an S3 connection in `S3CloudExplorer` (`F9`), navigates the bucket/prefix tree, inspects object tags/versions and generates a 1-click presigned URL in `S3InspectorPanel`, then triggers `"Generera S3-policy"` (`F11`).

---

## 3. Detailed Test Specifications by Milestone

### Milestone 1: `tests/renderer/redesign/m1_hermes_and_themes.test.ts` (ACTIVE)

#### Feature F1: Dead Hermes Code Eradication (8 Test Cases)
- `F1.1`: Verifies all 18+ dead Hermes source files and directories (`src/main/ai/HermesManager.ts`, `src/main/ai/desktop/`, `src/shared/types/nativeHermes.ts`, `integrations/hermes-desktop/`, `scripts/hermes/`, `tests/hermes/`) are completely deleted from the filesystem.
- `F1.2`: Verifies all 6 dead Hermes test files (`nativeHermesLayout.test.ts`, `nativeHermesTools.test.ts`, `nativeDesktopShell.test.ts`, `nativeWindow.test.ts`, `aiHub.hermes.integration.test.ts`, `fixtures/nativeHermesToolsContract.py`) are deleted.
- `F1.3`: Verifies `package.json` contains zero `hermes:*` scripts (`hermes:build`, `hermes:desktop:stage`, `hermes:desktop:build`).
- `F1.4`: Verifies `electron-builder.json` `extraResources` contains zero references to `hermes-desktop` or `hermes-native-runtime`.
- `F1.5`: Verifies shared IPC and AI contracts (`src/shared/types/ai.ts`, `src/shared/types/ipc.ts`, `src/shared/ipc/createMultiSSHApi.ts`, `src/preload/index.ts`) do not expose `useHermes`, `AiHermesStatus`, `NativeHermesApi`, or `enableNativeHermes`.
- `F1.6`: Verifies main process and hub services (`src/main/desktopEntry.ts`, `src/main/index.ts`, `src/main/ai/hub/AgentRuntime.ts`, `src/main/ai/hub/HubService.ts`, `src/main/ai/hub/createHub.ts`) do not import `HermesManager` or branch on `SSHS3_FORCE_NATIVE_HERMES`.
- `F1.7`: Verifies renderer components (`src/renderer/src/App.tsx`, `src/renderer/src/components/AiHub/TerminalControl.tsx`, `src/renderer/src/lib/aiHub.ts`, `src/renderer/src/components/AiHub/AiHubPanel.tsx`) have zero references to `nativeHermes` or `useHermes`.
- `F1.8` (Boundary / Preservation): Verifies `src/main/ai/hub/DirectAgentRuntime.ts` and `src/main/ai/CodexAuthProvider.ts` (including backwards-compatible token path fallback) remain intact and functional.

#### Feature F2: Multi-Theme Cyber-Clean Design System (6 Test Cases)
- `F2.1`: Verifies `src/renderer/src/index.css` defines all required semantic surface, border, text, and accent tokens (`--bg-app`, `--bg-surface`, `--bg-surface-subtle`, `--bg-surface-hover`, `--bg-card`, `--bg-input`, `--border-divider`, `--border-subtle`, `--border-strong`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-primary`, `--accent-hover`) across `:root` (Dark), `.light` (Light), and `.breeze` (Breeze).
- `F2.2`: Verifies `:root`, `.light`, and `.breeze` have distinct, non-empty hex/rgba token values appropriate to their color schemes (`color-scheme: light` on `.light`, `color-scheme: dark` on `.breeze`).
- `F2.3`: Verifies `src/renderer/src/components/AiHub/aiHub.css` uses semantic CSS variables (`var(--bg-`, `var(--text-`, `var(--border-`, `var(--accent-`) rather than hardcoded pitch-black root backgrounds (`#070b13`, `#05080f`).
- `F2.4`: Verifies `.sshs3-mission-canvas`, `.sshs3-glass-panel`, `.sshs3-kpi-card`, and `.sshs3-blade-card` in `src/renderer/src/index.css` adapt across themes using semantic tokens or theme-aware overrides instead of hardcoded `#060911` dark-only lock-in.
- `F2.5`: Verifies `src/renderer/src/components/LandingView.tsx` uses theme-aware semantic classes (`text-txt-primary`, `text-txt-secondary`, `bg-app-surface`, `bg-app-card`, etc.) rather than hardcoded `bg-[#060911]` or `bg-[#070b13]` container backgrounds.
- `F2.6` (Tier 2/3 Runtime DOM Theme Switching): Renders `LandingView` under `:root` (Dark), `.light`, and `.breeze` classes on `document.documentElement` and verifies clean rendering, interactive Server Blades, and theme compatibility.

#### Feature F3: Micro-Interactions & Glassmorphism (5 Test Cases)
- `F3.1`: Verifies keyframe animations (`@keyframes sshs3-card-enter`, `sshs3-drawer-open`, `sshs3-sonar`, `sshs3-sonar-amber`, `sshs3-sparkline-pulse`) are defined in `src/renderer/src/index.css`.
- `F3.2`: Verifies `.sshs3-glass-panel` defines `backdrop-filter: blur(...)` for glassmorphism.
- `F3.3`: Verifies slide-over drawer, status bar, and pill utility classes (`.sshs3-slide-drawer`, `.sshs3-status-bar`, `.sshs3-telemetry-pill`, `.sshs3-copilot-pill`, `.sshs3-drawer-anim`) and cubic-bezier transitions are present in `src/renderer/src/index.css`.
- `F3.4`: Verifies `@media (prefers-reduced-motion: reduce)` accessibility rule disables or shortens animations and transitions in `src/renderer/src/index.css`.
- `F3.5`: Verifies typography scale tokens (`--text-2xs`, `--text-xs`) and tightened border-radius tokens (`--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-2xl`) are defined in `@theme` in `src/renderer/src/index.css`.

---

### Milestone 2 (Planned): `tests/renderer/redesign/m2_shell_drawers_and_hud.test.tsx`

#### Feature F4: Airy Tab-Centered Topbar & Omnibar (>= 5 Test Cases)
- `F4.1`: Topbar renders with airy height (`h-11` / 44px) containing Brand/Fleet home trigger, scrollable Workspace Tabs, central Omnibar trigger (`Cmd+K` / `Ctrl+K`), and left/right drawer toggles without legacy 7-icon modal sprawl.
- `F4.2`: Clicking the central Omnibar button or pressing `Ctrl+K` / `Cmd+K` opens `GlobalSearchPalette`.
- `F4.3`: Clicking the Brand / Mission Control button switches to the Fleet Home view (`activeTabId === ''`) without closing open session tabs.
- `F4.4`: Left drawer trigger toggles `'connections'` drawer; right drawer trigger toggles `'ai'` / `'settings'` drawer.
- `F4.5` (Boundary): Topbar with 12+ open tabs keeps Omnibar and drawer triggers pinned and visible while tab strip scrolls horizontally with `.no-scrollbar`.

#### Feature F5: Slide-Over Side Panels / Drawers (>= 5 Test Cases)
- `F5.1`: `SlideOverDrawer` renders left drawer (`'connections'`) containing `ConnectionManagerModal` in slide-over mode.
- `F5.2`: `SlideOverDrawer` renders right drawers for `'tunnels'` (`SSHGlobalTunnelsModal`), `'dirsync'` (`DirSyncSavedProfilesModal`), `'settings'` (`SettingsModal`), and `'ai'` (`AiHubPanel`).
- `F5.3`: Pressing `Escape` or clicking the backdrop closes the active slide-over drawer and restores focus cleanly.
- `F5.4`: Switching directly from `'connections'` drawer to `'settings'` drawer transitions cleanly without leaving stale backdrop overlays.
- `F5.5` (Cross-Feature F4 + F5): Selecting "Settings", "SSH Tunnels", or "Connections" from the `Cmd+K` Omnibar opens the corresponding slide-over drawer.

#### Feature F6: Persistent Bottom Status Bar & Global Transfer HUD (>= 5 Test Cases)
- `F6.1`: `BottomStatusBar` is persistently mounted at the bottom of the app shell across Mission Control, Terminal tabs, SFTP tabs, and S3 tabs.
- `F6.2`: `GlobalTransferHud` subscribes to `window.multissh.onTransferProgress` / `transferList` at the top level and displays active transfer count, aggregate throughput (`MB/s`), and completion percentage `%`.
- `F6.3`: Clicking `GlobalTransferHud` in `BottomStatusBar` toggles the expandable `TransferQueueDrawer` even when the user is on an SSH Terminal tab or Mission Control.
- `F6.4`: `BottomStatusBar` provides quick theme switching (`Dark` / `Light` / `Breeze`) and displays connection/smartcard/CA status badges.
- `F6.5` (Boundary): When 0 transfers are active, `GlobalTransferHud` renders a quiet idle state (`Inga aktiva överföringar` / `0 active`) and handles failed/paused transfer badges accurately.

---

### Milestone 3 (Planned): `tests/renderer/redesign/m3_telemetry_and_host_split.test.tsx`

#### Feature F7: Hybrid Server Blades & Session Telemetry Pill (>= 5 Test Cases)
- `F7.1`: Mission Control (`LandingView`) renders Fleet Server Blades with live SVG sparklines, latency/CPU KPIs, and cluster topology filter.
- `F7.2`: Active terminal/workspace tabs render `SessionTelemetryPill` (`data-testid="session-telemetry-pill"`) in the header with live CPU %, latency (ms), 8-point SVG `<polyline>` sparkline, and health status indicator.
- `F7.3`: Clicking `SessionTelemetryPill` expands the detail telemetry popover showing CPU/RAM/Load metrics and quick action buttons (`Split SFTP`, `Diagnose with AI`, `Open Fleet Tab`).
- `F7.4`: Clicking `Diagnose with AI` inside `SessionTelemetryPill` dispatches `sshs3:ai-open` with host telemetry context and opens the AI Hub drawer.
- `F7.5` (Boundary): `SessionTelemetryPill` gracefully handles disconnected/offline sessions or high-load warning thresholds (>85% CPU turns indicator amber/red).

#### Feature F8: SSH + SFTP Split View (Host Workspace) (>= 5 Test Cases)
- `F8.1`: `PaneLeaf` supports `leafType: 'terminal' | 'sftp'`, rendering `TerminalView` for `'terminal'` leaves and an SFTP file browser (`FilePane` / `DualPaneExplorer`) for `'sftp'` leaves within the same tab.
- `F8.2`: Clicking `"Split SFTP"` in a terminal pane header or `SessionTelemetryPill` splits the current Host Workspace tab side-by-side (`orientation: 'row'`) with the SFTP browser pre-bound to the same `SSHConnectionConfig`.
- `F8.3`: Closing the SFTP split leaf restores the single-pane SSH terminal without terminating the underlying PTY session (React Portal preservation).
- `F8.4`: Dragging or opening a file from the split SFTP pane opens `FileEditorModal` or uploads to the co-located terminal session.
- `F8.5` (Cross-Feature F6 + F8): Initiating a file download/upload in the split SFTP pane immediately updates `GlobalTransferHud` in `BottomStatusBar` while typing in the adjacent SSH terminal pane.

---

### Milestone 4 (Planned): `tests/renderer/redesign/m4_s3_inspector_and_copilot.test.tsx`

#### Feature F9: Dedicated S3 Cloud Explorer & Inspector (>= 5 Test Cases)
- `F9.1`: Connecting to an S3 profile (`source.type === 's3'`) renders the 3-column `S3CloudExplorer`: Left bucket/prefix tree, center virtualized object table with storage class badges, right `S3InspectorPanel`.
- `F9.2`: Selecting a bucket or prefix in the left tree navigates the center object table and updates bucket-level metrics/policy status in `S3InspectorPanel`.
- `F9.3`: Selecting an object in the center table populates `S3InspectorPanel` with object size, ETag, last modified, storage class, tags (`s3GetTags`), and version history (`s3ListVersions`).
- `F9.4`: Clicking the 1-click Presigned URL button in `S3InspectorPanel` invokes `window.multissh.s3GetPresignedUrl`, displays the generated URL with expiry selector, and copies it to clipboard.
- `F9.5`: Editing and saving object tags in `S3InspectorPanel` calls `window.multissh.s3PutTags` and refreshes the inspector state.

#### Feature F10: Ambient Terminal Co-Pilot Pill (>= 5 Test Cases)
- `F10.1`: When a command in `TerminalView` exits with a non-zero exit code, the floating pill `[ ⌘K Förklara & Åtgärda ]` (`data-testid="terminal-copilot-pill"`) appears cleanly in the terminal viewport.
- `F10.2`: Clicking `terminal-copilot-pill` (or pressing the shortcut) dispatches `sshs3:ai-open` containing the failed command, exit code, and recent terminal output buffer, opening `AiHubPanel` with Orama RAG context.
- `F10.3`: Dismissing the Co-Pilot pill hides it until the next non-zero command exit or manual invocation.
- `F10.4`: When a subsequent command succeeds (exit code `0`), any stale error pill is automatically cleared or updated.
- `F10.5` (Boundary): Terminal output containing ANSI escape sequences, control characters, and multi-line stack traces is sanitized cleanly before being attached to the AI Hub prompt.

#### Feature F11: Contextual SFTP/S3 AI Actions (>= 5 Test Cases)
- `F11.1`: Selecting config files in SFTP/FilePane and triggering `"Förklara konfigurationsdiff"` opens `AiHubPanel` with the file diff / configuration context pre-populated.
- `F11.2`: Triggering `"Generera S3-policy"` from `S3CloudExplorer` / `S3InspectorPanel` opens `AiHubPanel` with the target bucket ARN, prefix, and least-privilege IAM/bucket policy prompt.
- `F11.3`: Triggering `"Indexera i Kunskapsbas"` on a folder or S3 bucket invokes `hubRequest({ action: 'kb-ingest-folder' | 'kb-ingest-s3', ... })` to index runbooks into `@orama/orama`.
- `F11.4`: SFTP and S3 context menus (`filePaneContextMenu.ts`) expose the three contextual AI actions with appropriate icons and labels.
- `F11.5` (Tier 4 End-to-End Scenario): Full workflow combining S3 object inspection (`F9`), indexing documentation into Orama (`F11`), encountering a terminal error (`F10`), and opening the AI Hub slide-over drawer (`F5`) under Light/Breeze theme (`F2`).

---

## 4. How to Run the Redesign E2E Test Suite

```bash
# Run all UI Redesign E2E & Milestone verification tests:
npx vitest run tests/renderer/redesign/

# Run Milestone 1 verification tests specifically:
npx vitest run tests/renderer/redesign/m1_hermes_and_themes.test.ts

# Run full project typecheck and test suite:
npm run typecheck
npm test
```
