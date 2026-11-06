import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HubHost } from '../../src/main/ai/hub/HubService';

/**
 * Demo mode belongs to the process (src/main/demo/demoMode.ts). It is decided once, when that module is
 * first loaded, from `--demo` or `SSHS3_DEMO=1` (`SSHS3_DEMO_WORKSPACE=1` is an alias), and never from
 * anything stored. `launch` loads a fresh copy of the module with a given command line and environment,
 * the way a newly started process loads it.
 */

type DemoModeModule = typeof import('../../src/main/demo/demoMode');

const DEMO_ENV = ['SSHS3_DEMO', 'SSHS3_DEMO_WORKSPACE'] as const;
type DemoEnv = Partial<Record<(typeof DEMO_ENV)[number], string>>;

/** Command lines without demo mode: `electron .` (npm run dev), a packaged app, the web server. */
const DEV = ['/opt/sshs3/node_modules/electron/dist/electron', '--no-sandbox', '.'];
const PACKAGED = ['C:\\Program Files\\sshs3\\sshs3.exe'];
const WEB_SERVER = ['/usr/bin/node', '/opt/sshs3/dist-web/server.mjs'];

const savedArgv = [...process.argv];
const savedEnv = new Map(DEMO_ENV.map((name) => [name, process.env[name]] as const));

afterEach(() => {
  process.argv = [...savedArgv];
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Loads demoMode as a process started with `argv` and (only) these demo variables loads it. */
async function launch(argv: readonly string[], env: DemoEnv = {}): Promise<DemoModeModule> {
  process.argv = [...argv];
  for (const name of DEMO_ENV) delete process.env[name];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) process.env[name] = value;
  }
  vi.resetModules();
  return import('../../src/main/demo/demoMode');
}

describe('demo mode is decided once, when the process starts', () => {
  it('is on when started with --demo: npm run demo, a packaged app, the web server', async () => {
    const commandLines = [
      [...DEV, '--demo'],
      [...PACKAGED, '--demo'],
      [...PACKAGED, '--background', '--demo'],
      [...WEB_SERVER, '--demo'],
    ];
    for (const argv of commandLines) {
      expect((await launch(argv)).isDemoMode(), argv.join(' ')).toBe(true);
    }
  });

  it('is on when started with SSHS3_DEMO=1, or with its alias SSHS3_DEMO_WORKSPACE=1', async () => {
    expect((await launch(DEV, { SSHS3_DEMO: '1' })).isDemoMode()).toBe(true);
    expect((await launch(WEB_SERVER, { SSHS3_DEMO: '1' })).isDemoMode()).toBe(true);
    expect((await launch(PACKAGED, { SSHS3_DEMO_WORKSPACE: '1' })).isDemoMode()).toBe(true);
  });

  it('is off otherwise, also for look-alike arguments and variables that are not 1', async () => {
    const launches: Array<[readonly string[], DemoEnv]> = [
      [DEV, {}],
      [PACKAGED, {}],
      [WEB_SERVER, {}],
      [[...PACKAGED, '--demo-lab'], {}],
      [[...PACKAGED, 'demo'], {}],
      [PACKAGED, { SSHS3_DEMO: '0' }],
      [PACKAGED, { SSHS3_DEMO: '' }],
      [PACKAGED, { SSHS3_DEMO_WORKSPACE: '0' }],
    ];
    for (const [argv, env] of launches) {
      expect((await launch(argv, env)).isDemoMode(), `${argv.join(' ')} ${JSON.stringify(env)}`).toBe(false);
    }
  });

  it('never changes while the process runs, whatever later happens to its command line or environment', async () => {
    const normal = await launch(PACKAGED);
    process.argv.push('--demo');
    process.env.SSHS3_DEMO = '1';
    process.env.SSHS3_DEMO_WORKSPACE = '1';
    expect(normal.isDemoMode()).toBe(false);
    expect(normal.isDemoTarget('demo-netapp-aff-a800-01a')).toBe(false);

    const demo = await launch([...PACKAGED, '--demo'], { SSHS3_DEMO: '1' });
    process.argv = [...PACKAGED];
    for (const name of DEMO_ENV) delete process.env[name];
    expect(demo.isDemoMode()).toBe(true);
    expect(demo.isDemoTarget('demo-netapp-aff-a800-01a')).toBe(true);
    expect(normal.isDemoMode()).toBe(false);
  });

  it('has one source of truth: demoWorkspace re-exports the very same isDemoMode', async () => {
    const mode = await launch([...PACKAGED, '--demo']);
    const workspace = await import('../../src/main/ai/hub/demoWorkspace');
    expect(workspace.isDemoMode).toBe(mode.isDemoMode);
    expect(workspace.isDemoMode()).toBe(true);
  });

  it('is never derived anywhere else: no other source reads --demo, SSHS3_DEMO or a stored Demo-Lab preference', () => {
    const src = path.join(__dirname, '../../src');
    const demoModeSource = path.join(src, 'main', 'demo', 'demoMode.ts');
    const derivations: ReadonlyArray<readonly [string, RegExp]> = [
      ['checks the command line for --demo', /\bargv\b[^\n;]*(?:['"`]--demo['"`]|\bDEMO_FLAG\b)/],
      ['reads SSHS3_DEMO from the environment', /process\.env(?:\.|\[\s*['"`])SSHS3_DEMO/],
      ['decides it again with demoModeRequested()', /\bdemoModeRequested\s*\(/],
      ['reads or declares the Demo-Lab preference', /\.demoLabEnabled\b|\bdemoLabEnabled\??\s*:/],
    ];
    const sourceFiles = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.(?:ts|tsx|cjs|mjs|js)$/.test(entry.name) ? [full] : [];
      });
    const offenders: string[] = [];
    for (const file of sourceFiles(src)) {
      if (file === demoModeSource) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const [what, pattern] of derivations) {
        if (pattern.test(text)) offenders.push(`${path.relative(src, file)} ${what}; use isDemoMode() instead`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('stored preferences never decide demo mode', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  /**
   * Starts the AI Hub of the launched process on a hub.json an older build left behind (those builds stored
   * the Demo-Lab toggle as preferences.demoLabEnabled and let it switch demo mode). Returns what is on disk
   * once the hub has initialized.
   */
  async function startHub(storedPreferences: Record<string, unknown>, host: Partial<HubHost>) {
    const { HubService } = await import('../../src/main/ai/hub/HubService');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sshs3-demo-launch-'));
    const hubFile = path.join(dir, 'hub.json');
    await fsp.writeFile(
      hubFile,
      JSON.stringify({
        version: 1,
        preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30, ...storedPreferences },
        tasks: [],
        memories: [],
        schedules: [],
        inventory: [],
        history: [],
      }),
    );
    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => 'schedule-session',
        show: () => {},
        aiConfigFilePath: path.join(dir, 'ai-config.json'),
        ...host,
      },
      dir,
    );
    cleanups.push(async () => {
      await hub.dispose();
      await fsp.rm(dir, { recursive: true, force: true });
    });
    await hub.initialize();
    const stored = JSON.parse(await fsp.readFile(hubFile, 'utf8')) as { preferences: Record<string, unknown> };
    return { hub, stored };
  }

  it('a process started without --demo runs in normal mode, even if Demo-Lab was stored as on', async () => {
    const mode = await launch(PACKAGED);
    const relaunchForDemoMode = vi.fn(async (_demoMode: boolean) => true);
    const { hub, stored } = await startHub({ demoLabEnabled: true }, { relaunchForDemoMode });

    expect(mode.isDemoMode()).toBe(false);
    const snapshot = await hub.snapshot();
    expect(snapshot.demoMode).toBe(false);
    // The old preference is dropped on load: neither kept in memory nor written back, and it restarts nothing.
    expect(snapshot.preferences).not.toHaveProperty('demoLabEnabled');
    expect(stored.preferences).not.toHaveProperty('demoLabEnabled');
    expect(relaunchForDemoMode).not.toHaveBeenCalled();
    expect(mode.isDemoMode()).toBe(false);
  }, 30_000);

  it('a process started with --demo runs in demo mode, even if Demo-Lab was stored as off', async () => {
    const mode = await launch([...PACKAGED, '--demo']);
    const relaunchForDemoMode = vi.fn(async (_demoMode: boolean) => true);
    const { hub, stored } = await startHub({ demoLabEnabled: false }, { relaunchForDemoMode });

    expect(mode.isDemoMode()).toBe(true);
    const snapshot = await hub.snapshot();
    expect(snapshot.demoMode).toBe(true);
    expect(snapshot.preferences).not.toHaveProperty('demoLabEnabled');
    expect(stored.preferences).not.toHaveProperty('demoLabEnabled');
    expect(relaunchForDemoMode).not.toHaveBeenCalled();
    expect(mode.isDemoMode()).toBe(true);
  }, 30_000);
});
