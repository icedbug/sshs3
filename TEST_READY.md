# End-to-End Test Suite Ready (`TEST_READY.md`)

**Project**: `sshs3` — Complete UI Redesign & Hermes Eradication (`codex/ai-hub`)  
**Authoritative Spec**: `/home/antigravity/icedbug/sshs3/.agents/teamwork/ORIGINAL_REQUEST.md` & `/home/antigravity/icedbug/sshs3/PROJECT.md`  
**Test Infrastructure Spec**: `/home/antigravity/icedbug/sshs3/TEST_INFRA.md`  
**Status**: **READY — 100% PASSING (5 Test Files, 62 Tests, 0 Lint Errors)**

---

## Test Runner

Run the complete UI Redesign E2E & Milestone verification suite from `/home/antigravity/icedbug/sshs3`:

```bash
# Run all UI Redesign E2E & Milestone tests (Tiers 1–4):
npx vitest run tests/renderer/redesign/

# Run ESLint verification on the redesign test suite:
npx eslint tests/renderer/redesign/

# Run individual milestone & workflow test files:
npx vitest run tests/renderer/redesign/m1_hermes_and_themes.test.ts
npx vitest run tests/renderer/redesign/m2_topbar_drawers_statusbar.test.tsx
npx vitest run tests/renderer/redesign/m3_telemetry_and_host_split.test.tsx
npx vitest run tests/renderer/redesign/m4_s3_inspector_and_ai_actions.test.tsx
npx vitest run tests/renderer/redesign/e2e_tiers3_and_4_workflows.test.tsx
```

---

## Coverage Summary Across Tiers 1–4

| Tier | Scope & Methodology | Test Files | Test Count | Result |
|------|---------------------|------------|------------|--------|
| **Tier 1: Feature Coverage** | Primary behavioral contracts, DOM structures, `data-testid` invariants, semantic CSS tokens, IPC & CustomEvent payloads across `F1`–`F11` | `m1_hermes_and_themes.test.ts`<br>`m2_topbar_drawers_statusbar.test.tsx`<br>`m3_telemetry_and_host_split.test.tsx`<br>`m4_s3_inspector_and_ai_actions.test.tsx` | 35 | **PASS (100%)** |
| **Tier 2: Boundary & Corner Cases** | Preserved runtime modules (`DirectAgentRuntime`, `CodexAuthProvider`), `prefers-reduced-motion: reduce`, 0-active transfer idle states, `transferList` fallback, high-load CPU/latency warning thresholds (`>85%` CPU / `>150ms`), offline/disconnected states, out-of-range sparkline clamping | `m1_hermes_and_themes.test.ts`<br>`m2_topbar_drawers_statusbar.test.tsx`<br>`m3_telemetry_and_host_split.test.tsx`<br>`e2e_tiers3_and_4_workflows.test.tsx` | 11 | **PASS (100%)** |
| **Tier 3: Cross-Feature Combinations** | Pairwise & multi-feature interactions: Multi-Theme (`Dark`/`Light`/`Breeze`) + Slide-Over Drawers + AI Hub (`T3.1`), Topbar + Omnibar mutually exclusive drawers (`T3.2`), Tab switching + persistent Global Transfer HUD (`T3.3`), Host Workspace SFTP Split + live Transfer HUD (`T3.4`), `SessionTelemetryPill` + `PaneTree` split synchronization (`T3.5`), Telemetry Pill `"Diagnose with AI"` + AI Hub drawer (`T3.6`), S3 Cloud Inspector + AI Policy & Orama KB indexing (`T3.7`), SFTP FilePane + `"Förklara konfigurationsdiff"` (`T3.8`), Ambient Terminal Co-Pilot + AI Hub drawer (`T3.9`) | `e2e_tiers3_and_4_workflows.test.tsx` | 9 | **PASS (100%)** |
| **Tier 4: Real-World Application Scenarios** | End-to-end operator workflows across all 6 locked `/grill-me` user decisions: Operator Shell & Theme Tour (`T4.1`), Scenario A Fleet Incident Triage (`T4.2`), Scenario B Host Workspace Live Config Fix (`T4.3`), Scenario C Cloud Object Storage Governance (`T4.4`), Multi-Node Cluster Split + AI Split-Analys (`T4.5`), Adversarial HTML/script/ANSI escaping integrity (`T4.6`), Unified 6-Decision End-to-End Tour (`T4.7`) | `e2e_tiers3_and_4_workflows.test.tsx` | 7 | **PASS (100%)** |
| **Total** | **Complete UI Redesign & Hermes Eradication Suite (`F1`–`F11`)** | **5 Files in `tests/renderer/redesign/`** | **62 Tests** | **62 / 62 PASS** |

---

## Feature Checklist (`F1`–`F11`)

- [x] **F1 — Dead Hermes Code Eradication (`M1`)**:
  - Verified in `tests/renderer/redesign/m1_hermes_and_themes.test.ts` (`F1.1`–`F1.8`, 8 tests).
  - Confirms all 18+ dead Hermes source files/directories and 6 dead Hermes test files are deleted, `package.json` and `electron-builder.json` have zero Hermes scripts/resources, IPC/preload/renderer contracts have zero `nativeHermes`/`useHermes` references, and `DirectAgentRuntime.ts` + `CodexAuthProvider.ts` remain intact.
- [x] **F2 — Multi-Theme Cyber-Clean Design System (`M1`)**:
  - Verified in `tests/renderer/redesign/m1_hermes_and_themes.test.ts` (`F2.1`–`F2.6`, 8 tests) & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.1`, `T4.1`).
  - Confirms all semantic CSS tokens (`--bg-app`, `--bg-surface`, `--bg-card`, `--bg-glass`, `--text-primary`, `--accent-primary`, etc.) are defined and distinct across `:root` (Dark), `.light` (Light), and `.breeze` (Breeze), `aiHub.css` and `LandingView.tsx` use semantic tokens, and runtime DOM theme switching works across all views.
- [x] **F3 — Micro-Interactions & Glassmorphism (`M1`)**:
  - Verified in `tests/renderer/redesign/m1_hermes_and_themes.test.ts` (`F3.1`–`F3.5`, 5 tests).
  - Confirms keyframe animations (`sshs3-card-enter`, `sshs3-drawer-open`, `sshs3-sonar`, `sshs3-sonar-amber`, `sshs3-sparkline-pulse`), `.sshs3-glass-panel` `backdrop-filter: blur(...)`, `.sshs3-slide-drawer*`, `.sshs3-status-bar`, `.sshs3-telemetry-pill`, `.sshs3-copilot-pill`, and `@media (prefers-reduced-motion: reduce)`.
- [x] **F4 — Airy Tab-Centered Topbar & Omnibar (`M2`)**:
  - Verified in `tests/renderer/redesign/m2_topbar_drawers_statusbar.test.tsx` & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.2`, `T4.1`).
  - Confirms `h-11` (`44px`) `app-topbar` with `topbar-brand-home`, `drawer-toggle-connections`, scrollable tab bar, central `omnibar-trigger` (`GlobalSearchPalette`), quick action chips, `>` command execution, and right drawer toggles.
- [x] **F5 — Slide-Over Side Panels / Drawers (`M2`)**:
  - Verified in `tests/renderer/redesign/m2_topbar_drawers_statusbar.test.tsx` & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.1`, `T3.2`, `T3.6`, `T3.9`, `T4.7`).
  - Confirms `SlideOverDrawer` (`drawer-connections` on left; `drawer-settings`, `drawer-tunnels`, `drawer-dirsync`, and `drawer-ai` on right), Escape & backdrop dismissal, and mutually exclusive drawer transitions.
- [x] **F6 — Persistent Bottom Status Bar & Global Transfer HUD (`M2`)**:
  - Verified in `tests/renderer/redesign/m2_topbar_drawers_statusbar.test.tsx` & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.3`, `T3.4`, `T4.3`).
  - Confirms `bottom-status-bar` persistence across Mission Control, Terminal, and File Manager tabs, live `global-transfer-hud` throughput/percentage tracking, expandable `global-transfer-drawer` with Pause/Clear controls, and `status-theme-switcher`.
- [x] **F7 — Hybrid Server Blades & Session Telemetry Pill (`M3`)**:
  - Verified in `tests/renderer/redesign/m3_telemetry_and_host_split.test.tsx` (`F7.1`–`F7.6`, 6 tests) & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.5`, `T3.6`, `T4.3`, `T4.7`).
  - Confirms Server Blade `"Host Workspace (SSH + SFTP)"` button (`blade-connect-workspace-${id}`), inline `session-telemetry-pill` with sonar health dot (`session-telemetry-dot`), CPU % (`session-telemetry-cpu`), latency (`session-telemetry-latency`), 8-point SVG `<polyline>` (`session-telemetry-sparkline`), 1-click detail popover (`session-telemetry-detail`), `"Split SFTP"`, `"Diagnose with AI"`, and `"Open Fleet Overview"`.
- [x] **F8 — SSH + SFTP Split View / Host Workspace (`M3`)**:
  - Verified in `tests/renderer/redesign/m3_telemetry_and_host_split.test.tsx` (`F8.1`–`F8.6`, 6 tests) & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.4`, `T3.5`, `T4.3`, `T4.7`).
  - Confirms `PaneLeaf` `surfaceType: 'sftp'` / `leafType: 'sftp'`, `pane-split-sftp` header button, side-by-side SSH terminal + `DualPaneExplorer` (`host-workspace-sftp-pane`), keyboard-resizable `SplitDivider`, portal session preservation on `close-sftp-split`, and automatic Server Blade Host Workspace split handoff.
- [x] **F9 — Dedicated S3 Cloud Explorer & Inspector (`M4`)**:
  - Verified in `tests/renderer/redesign/m4_s3_inspector_and_ai_actions.test.tsx` & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.7`, `T4.4`, `T4.6`).
  - Confirms 3-column `S3CloudExplorer` (`s3-bucket-tree` with filter, `s3-object-table`, and `s3-inspector-panel`), object metadata, bucket metrics & policy/CORS preview, 1-click Presigned URL generator (`s3-presign-generate-btn`), inline Object Tags editor (`s3-tags-save-btn`), and Version History restore (`s3-version-restore-*`).
- [x] **F10 — Ambient Terminal Co-Pilot Pill (`M4`)**:
  - Verified in `tests/renderer/redesign/m4_s3_inspector_and_ai_actions.test.tsx` & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.9`, `T4.2`, `T4.7`).
  - Confirms non-zero exit code detection (`OSC 133;D;<exitCode>`) in `TerminalView` surfaces `.sshs3-copilot-pill` (`terminal-copilot-pill` / `terminal-fix-error-btn`) and dispatches `sshs3:ai-open` with terminal output context to open the AI Hub drawer.
- [x] **F11 — Contextual SFTP/S3 AI Actions (`M4`)**:
  - Verified in `tests/renderer/redesign/m4_s3_inspector_and_ai_actions.test.tsx` & `e2e_tiers3_and_4_workflows.test.tsx` (`T3.7`, `T3.8`, `T4.4`).
  - Confirms contextual AI actions `"Förklara konfigurationsdiff"` (`ai-action-explain-diff`), `"Generera S3-policy"` (`ai-action-generate-s3-policy`), and `"Indexera i Kunskapsbas"` (`ai-action-index-kb` -> `kb-ingest-s3` / `kb-ingest-folder`) across `FilePane`, `S3InspectorPanel`, and context menus.
