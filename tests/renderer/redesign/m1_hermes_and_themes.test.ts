// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { LandingView } from '../../../src/renderer/src/components/LandingView';
import type { SSHConnectionConfig } from '@shared/types/ssh';

const ROOT_DIR = resolve(__dirname, '../../..');

function resolveProjectPath(relativePath: string): string {
  return resolve(ROOT_DIR, relativePath);
}

function readProjectFile(relativePath: string): string {
  return readFileSync(resolveProjectPath(relativePath), 'utf8');
}

/**
 * Extracts the CSS declaration block body for a given selector from a CSS stylesheet string.
 */
function extractCssBlocks(css: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(css)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

describe('Milestone 1 E2E & Feature Verification: Hermes Eradication (F1) & Multi-Theme Cyber-Clean Design System (F2, F3)', () => {
  // ============================================================================
  // FEATURE F1: Dead Hermes Code Eradication (Tier 1 & Tier 2 Boundary)
  // ============================================================================
  describe('F1: Dead Hermes Code Eradication', () => {
    const DEAD_HERMES_SOURCE_PATHS = [
      'src/main/ai/HermesManager.ts',
      'src/main/ai/desktop/NativeDesktopShell.ts',
      'src/main/ai/desktop/layout.ts',
      'src/main/ai/desktop/nativeEvents.ts',
      'src/main/ai/desktop/nativeTools.ts',
      'src/main/ai/desktop/nativeWindow.ts',
      'src/main/ai/desktop/NativeToolBridge.ts',
      'src/shared/types/nativeHermes.ts',
      'integrations/hermes-desktop/preload-extension.cjs',
      'integrations/hermes-desktop/presentation.ts',
      'integrations/hermes-desktop/renderer-extension.tsx',
      'integrations/hermes-desktop/terminal-controls.tsx',
      'integrations/hermes-desktop/sshs3_terminal/__init__.py',
      'integrations/hermes-desktop/sshs3_terminal/environment.py',
      'integrations/hermes-desktop/sshs3_terminal/plugin.yaml',
      'integrations/hermes-desktop/sshs3_terminal/README.md',
      'scripts/hermes/build-desktop.mjs',
      'scripts/hermes/build-runtime.mjs',
      'scripts/hermes/desktop-source.json',
      'scripts/hermes/pm-build-runtime.py',
      'scripts/hermes/runtime-target-adapter.py',
      'scripts/hermes/sshs3_bootstrap.py',
      'scripts/hermes/stage-desktop.mjs',
      'tests/hermes/runtime-target-contract.py',
    ];

    const DEAD_HERMES_TEST_PATHS = [
      'tests/main/nativeHermesLayout.test.ts',
      'tests/main/nativeHermesTools.test.ts',
      'tests/main/nativeDesktopShell.test.ts',
      'tests/main/nativeWindow.test.ts',
      'tests/main/aiHub.hermes.integration.test.ts',
      'tests/main/fixtures/nativeHermesToolsContract.py',
    ];

    it('F1.1: removes all 18+ dead Hermes runtime, desktop shell, integration, and script files', () => {
      const remainingFiles = DEAD_HERMES_SOURCE_PATHS.filter((relPath) =>
        existsSync(resolveProjectPath(relPath))
      );
      expect(remainingFiles).toEqual([]);

      // Also verify the dead directories themselves are gone
      expect(existsSync(resolveProjectPath('src/main/ai/desktop'))).toBe(false);
      expect(existsSync(resolveProjectPath('integrations/hermes-desktop'))).toBe(false);
      expect(existsSync(resolveProjectPath('scripts/hermes'))).toBe(false);
      expect(existsSync(resolveProjectPath('tests/hermes'))).toBe(false);
    });

    it('F1.2: removes all 6 dead Hermes unit and integration test files', () => {
      const remainingTests = DEAD_HERMES_TEST_PATHS.filter((relPath) =>
        existsSync(resolveProjectPath(relPath))
      );
      expect(remainingTests).toEqual([]);
    });

    it('F1.3: cleans all hermes:* build scripts from package.json', () => {
      const pkgJson = JSON.parse(readProjectFile('package.json')) as {
        scripts?: Record<string, string>;
      };
      expect(pkgJson.scripts).toBeDefined();
      const scripts = pkgJson.scripts ?? {};

      expect(scripts['hermes:build']).toBeUndefined();
      expect(scripts['hermes:desktop:stage']).toBeUndefined();
      expect(scripts['hermes:desktop:build']).toBeUndefined();

      const hermesScriptKeys = Object.keys(scripts).filter((k) =>
        k.toLowerCase().includes('hermes')
      );
      expect(hermesScriptKeys).toEqual([]);

      const hermesScriptValues = Object.values(scripts).filter((v) =>
        v.toLowerCase().includes('scripts/hermes')
      );
      expect(hermesScriptValues).toEqual([]);
    });

    it('F1.4: cleans all hermes-desktop and hermes-native-runtime extraResources from electron-builder.json', () => {
      const builderRaw = readProjectFile('electron-builder.json');
      const builderConfig = JSON.parse(builderRaw) as {
        extraResources?: Array<{ from?: string; to?: string }>;
      };

      expect(builderRaw).not.toContain('hermes-desktop');
      expect(builderRaw).not.toContain('hermes-native-runtime');

      const extraResources = builderConfig.extraResources ?? [];
      const hermesResources = extraResources.filter(
        (res) =>
          res.from?.includes('hermes') ||
          res.to?.includes('hermes')
      );
      expect(hermesResources).toEqual([]);
    });

    it('F1.5: removes useHermes, AiHermesStatus, NativeHermesApi, and enableNativeHermes from shared IPC & preload contracts', () => {
      const aiTypes = readProjectFile('src/shared/types/ai.ts');
      expect(aiTypes.includes('useHermes')).toBe(false);
      expect(aiTypes.includes('AiHermesStatus')).toBe(false);

      const ipcTypes = readProjectFile('src/shared/types/ipc.ts');
      expect(ipcTypes.includes('NativeHermesApi')).toBe(false);
      expect(ipcTypes.includes('nativeHermes')).toBe(false);

      const createApi = readProjectFile('src/shared/ipc/createMultiSSHApi.ts');
      expect(createApi.includes('enableNativeHermes')).toBe(false);
      expect(createApi.includes('nativeHermes')).toBe(false);

      const preloadIndex = readProjectFile('src/preload/index.ts');
      expect(preloadIndex.includes('enableNativeHermes')).toBe(false);
    });

    it('F1.6: removes HermesManager and SSHS3_FORCE_NATIVE_HERMES branching from main process and HubService', () => {
      const desktopEntry = readProjectFile('src/main/desktopEntry.ts');
      expect(desktopEntry.includes('SSHS3_FORCE_NATIVE_HERMES')).toBe(false);
      expect(desktopEntry.includes('NativeDesktopShell')).toBe(false);

      const mainIndex = readProjectFile('src/main/index.ts');
      expect(mainIndex.includes('createNativeHermesWindow')).toBe(false);
      expect(mainIndex.includes('nativeHermes')).toBe(false);

      const agentRuntime = readProjectFile('src/main/ai/hub/AgentRuntime.ts');
      expect(agentRuntime.includes('HermesManager')).toBe(false);
      expect(agentRuntime.includes('DirectAgentRuntime')).toBe(true);

      const hubService = readProjectFile('src/main/ai/hub/HubService.ts');
      expect(hubService.includes('HermesManager')).toBe(false);
      expect(hubService.includes('SSHS3_NATIVE_HERMES')).toBe(false);

      const createHub = readProjectFile('src/main/ai/hub/createHub.ts');
      expect(createHub.includes('nativeEvents')).toBe(false);
    });

    it('F1.7: removes nativeHermes and useHermes references from renderer components (App.tsx, TerminalControl.tsx, aiHub.ts, AiHubPanel.tsx)', () => {
      const appTsx = readProjectFile('src/renderer/src/App.tsx');
      expect(appTsx.includes('nativeHermes')).toBe(false);

      const terminalControl = readProjectFile('src/renderer/src/components/AiHub/TerminalControl.tsx');
      expect(terminalControl.includes('NativeTerminalControl')).toBe(false);
      expect(terminalControl.includes('nativeHermes')).toBe(false);

      const aiHubLib = readProjectFile('src/renderer/src/lib/aiHub.ts');
      expect(aiHubLib.includes('nativeHermes')).toBe(false);

      const aiHubPanel = readProjectFile('src/renderer/src/components/AiHub/AiHubPanel.tsx');
      expect(aiHubPanel.includes('useHermes')).toBe(false);
    });

    it('F1.8 (Boundary / Preservation): preserves DirectAgentRuntime.ts and CodexAuthProvider.ts with backwards-compatible token path resolution', () => {
      expect(existsSync(resolveProjectPath('src/main/ai/hub/DirectAgentRuntime.ts'))).toBe(true);
      expect(existsSync(resolveProjectPath('src/main/ai/CodexAuthProvider.ts'))).toBe(true);

      const directRuntime = readProjectFile('src/main/ai/hub/DirectAgentRuntime.ts');
      expect(directRuntime.includes('export class DirectAgentRuntime')).toBe(true);

      const codexAuth = readProjectFile('src/main/ai/CodexAuthProvider.ts');
      expect(codexAuth.includes('CodexAuthProvider')).toBe(true);
      // Must preserve backwards-compatible auth.json lookup so existing user logins stay valid
      expect(codexAuth.includes('auth.json')).toBe(true);
    });
  });

  // ============================================================================
  // FEATURE F2: Multi-Theme Cyber-Clean Design System (Dark, Light, Breeze)
  // ============================================================================
  describe('F2: Multi-Theme Cyber-Clean Design System', () => {
    const REQUIRED_SEMANTIC_TOKENS = [
      '--bg-app',
      '--bg-surface',
      '--bg-surface-subtle',
      '--bg-surface-hover',
      '--bg-card',
      '--bg-input',
      '--border-subtle',
      '--border-divider',
      '--border-strong',
      '--text-primary',
      '--text-secondary',
      '--text-muted',
      '--accent-primary',
      '--accent-hover',
      '--accent-subtle',
    ];

    it('F2.1: defines all core semantic tokens on :root (Dark), .light (Light), and .breeze (Breeze) in index.css', () => {
      const indexCss = readProjectFile('src/renderer/src/index.css');

      const rootBody = extractCssBlocks(indexCss, ':root').join('\n');
      const lightBody = extractCssBlocks(indexCss, '.light').join('\n');
      const breezeBody = extractCssBlocks(indexCss, '.breeze').join('\n');

      expect(rootBody.length).toBeGreaterThan(0);
      expect(lightBody.length).toBeGreaterThan(0);
      expect(breezeBody.length).toBeGreaterThan(0);

      for (const token of REQUIRED_SEMANTIC_TOKENS) {
        expect(rootBody, `Missing ${token} in :root`).toContain(`${token}:`);
        expect(lightBody, `Missing ${token} in .light`).toContain(`${token}:`);
        expect(breezeBody, `Missing ${token} in .breeze`).toContain(`${token}:`);
      }

      // Also verify --bg-glass token is defined across themes per PROJECT.md § Interface Contracts 1
      expect(indexCss).toContain('--bg-glass');
    });

    it('F2.2: configures distinct color-scheme and background/text contrast values for Dark, Light, and Breeze', () => {
      const indexCss = readProjectFile('src/renderer/src/index.css');
      const rootBody = extractCssBlocks(indexCss, ':root').join('\n');
      const lightBody = extractCssBlocks(indexCss, '.light').join('\n');
      const breezeBody = extractCssBlocks(indexCss, '.breeze').join('\n');

      // Dark (:root) uses dark navy #0b0f19
      expect(rootBody).toMatch(/--bg-app:\s*#0b0f19/i);
      expect(rootBody).toMatch(/--text-primary:\s*#f8fafc/i);

      // Light (.light) sets color-scheme: light and light background / dark text
      expect(lightBody).toContain('color-scheme: light');
      expect(lightBody).toMatch(/--bg-card:\s*#ffffff/i);
      expect(lightBody).toMatch(/--text-primary:\s*#0f172a/i);

      // Breeze (.breeze) sets KDE charcoal #232627 / #31363b and Breeze blue #3daee9
      expect(breezeBody).toContain('color-scheme: dark');
      expect(breezeBody).toMatch(/--bg-app:\s*#232627/i);
      expect(breezeBody).toMatch(/--bg-surface:\s*#31363b/i);
      expect(breezeBody).toMatch(/--accent-primary:\s*#3daee9/i);
    });

    it('F2.3: refactors aiHub.css to use semantic design tokens instead of hardcoded pitch-black backgrounds', () => {
      const aiHubCss = readProjectFile('src/renderer/src/components/AiHub/aiHub.css');

      // Must reference semantic variables so Light and Breeze themes work seamlessly
      expect(aiHubCss.includes('var(--bg-')).toBe(true);
      expect(aiHubCss.includes('var(--text-')).toBe(true);
      expect(aiHubCss.includes('var(--border-')).toBe(true);

      // Must NOT lock the main .ai-hub container to pitch-black #070b13 / #05080f
      expect(/linear-gradient\(180deg,\s*#070b13\s+0%,\s*#05080f\s+100%\)/i.test(aiHubCss)).toBe(false);
    });

    it('F2.4: makes Mission Control canvas, glass panels, KPI cards, and Server Blade cards theme-aware in index.css', () => {
      const indexCss = readProjectFile('src/renderer/src/index.css');

      const canvasBlocks = extractCssBlocks(indexCss, '.sshs3-mission-canvas').join('\n');
      expect(canvasBlocks.length).toBeGreaterThan(0);
      // .sshs3-mission-canvas must not hardcode pitch-black #060911 without var(--bg-app)
      expect(canvasBlocks.includes('var(--bg-app')).toBe(true);

      const glassBlocks = extractCssBlocks(indexCss, '.sshs3-glass-panel').join('\n');
      expect(glassBlocks.length).toBeGreaterThan(0);

      const bladeBlocks = extractCssBlocks(indexCss, '.sshs3-blade-card').join('\n');
      expect(bladeBlocks.length).toBeGreaterThan(0);
    });

    it('F2.5: refactors LandingView.tsx away from hardcoded dark-only container colors (#060911, #070b13, #0b101b)', () => {
      const landingSource = readProjectFile('src/renderer/src/components/LandingView.tsx');

      // Should not contain hardcoded pitch-black hex backgrounds in JSX classes
      expect(landingSource.includes('#060911')).toBe(false);
      expect(landingSource.includes('#070b13')).toBe(false);
      expect(landingSource.includes('#0b101b')).toBe(false);

      // Root landing-view should use semantic text token (text-txt-primary) or theme-adaptive classes
      expect(landingSource.includes('sshs3-mission-canvas')).toBe(true);
      expect(landingSource.includes('text-txt-primary')).toBe(true);
    });

    describe('F2.6 (Tier 2 & Tier 3): Runtime DOM rendering of LandingView across Dark (:root), Light (.light), and Breeze (.breeze)', () => {
      const mockRecentSSH: SSHConnectionConfig[] = [
        {
          id: 'blade-1',
          name: 'prod-ontap-01',
          host: '10.20.30.10',
          port: 22,
          username: 'admin',
          authType: 'smartcard',
          group: 'NetApp MetroCluster',
        },
      ];

      beforeEach(() => {
        document.documentElement.className = '';
      });

      afterEach(() => {
        cleanup();
        document.documentElement.className = '';
      });

      it.each([
        { themeName: 'Dark (:root)', className: '' },
        { themeName: 'Light (.light)', className: 'light' },
        { themeName: 'Breeze (.breeze)', className: 'breeze' },
      ])('renders LandingView and interactive Server Blades cleanly under $themeName theme', ({ className }) => {
        if (className) {
          document.documentElement.classList.add(className);
        }

        const onConnectRecentSSH = vi.fn();
        const onConnectSFTP = vi.fn();

        render(
          React.createElement(LandingView, {
            recentSSH: mockRecentSSH,
            onConnectRecentSSH,
            onConnectSFTP,
            onQuickStartTerminal: vi.fn(),
            onNewTab: vi.fn(),
            onOpenProfiles: vi.fn(),
            onNewProfile: vi.fn(),
            onOpenSyncBootstrap: vi.fn(),
            onNavigateToTabBar: vi.fn(),
          })
        );

        const landingRoot = screen.getByTestId('landing-view');
        expect(landingRoot).toBeInTheDocument();
        expect(landingRoot.className).toContain('sshs3-mission-canvas');

        // Verify Server Blade card renders and Connect trigger works in every theme
        expect(screen.getByText('prod-ontap-01')).toBeInTheDocument();
        const connectBtn = screen.getByTestId('recent-connect-blade-1');
        fireEvent.click(connectBtn);
        expect(onConnectRecentSSH).toHaveBeenCalledWith(mockRecentSSH[0]);
      });
    });
  });

  // ============================================================================
  // FEATURE F3: Micro-Interactions, Slide-Over Utility Classes & Glassmorphism
  // ============================================================================
  describe('F3: Micro-Interactions & Glassmorphism', () => {
    it('F3.1: defines all Mission Control and drawer keyframe animations in index.css', () => {
      const indexCss = readProjectFile('src/renderer/src/index.css');

      expect(indexCss.includes('@keyframes sshs3-card-enter')).toBe(true);
      expect(indexCss.includes('@keyframes sshs3-drawer-open')).toBe(true);
      expect(indexCss.includes('@keyframes sshs3-sonar')).toBe(true);
      expect(indexCss.includes('@keyframes sshs3-sonar-amber')).toBe(true);
      expect(indexCss.includes('@keyframes sshs3-sparkline-pulse')).toBe(true);
    });

    it('F3.2: applies backdrop-filter blur glassmorphism to .sshs3-glass-panel', () => {
      const indexCss = readProjectFile('src/renderer/src/index.css');
      const glassBlocks = extractCssBlocks(indexCss, '.sshs3-glass-panel').join('\n');

      expect(glassBlocks).toMatch(/backdrop-filter:\s*blur\(\d+px\)/);
    });

    it('F3.3: defines slide-over drawer, status bar, telemetry pill, and copilot pill utility classes in index.css', () => {
      const indexCss = readProjectFile('src/renderer/src/index.css');

      // Core micro-interaction utility classes required by PROJECT.md § Interface Contracts 1
      const requiredClasses = [
        '.sshs3-drawer-anim',
        '.sshs3-sonar-emerald',
        '.sshs3-sparkline',
        '.sshs3-slide-drawer',
        '.sshs3-status-bar',
        '.sshs3-telemetry-pill',
        '.sshs3-copilot-pill',
      ];
      const missingClasses = requiredClasses.filter((cls) => !indexCss.includes(cls));
      expect(missingClasses).toEqual([]);
    });

    it('F3.4 (Boundary / Accessibility): enforces @media (prefers-reduced-motion: reduce) to suppress animations', () => {
      const indexCss = readProjectFile('src/renderer/src/index.css');

      expect(indexCss).toContain('@media (prefers-reduced-motion: reduce)');
      expect(indexCss).toContain('animation: none !important');
    });

    it('F3.5: defines crisp typography scale (--text-2xs, --text-xs) and corner radius scale in @theme', () => {
      const indexCss = readProjectFile('src/renderer/src/index.css');

      expect(indexCss).toContain('--text-2xs: 0.6875rem');
      expect(indexCss).toContain('--text-xs: 0.8125rem');
      expect(indexCss).toContain('--radius-md: 0.25rem');
      expect(indexCss).toContain('--radius-lg: 0.375rem');
      expect(indexCss).toContain('--radius-xl: 0.5rem');
      expect(indexCss).toContain('--radius-2xl: 0.625rem');
    });
  });
});
