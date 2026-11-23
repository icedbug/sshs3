import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeHermesDataDirs, resolveUserDataDir } from '../../src/main/demo/dataDir';
import { demoWorkspaceDir } from '../../src/main/demo/demoMode';

/**
 * A demo process keeps all of its state in `demo-workspace` inside the normal data directory
 * (demoWorkspaceDir in src/main/demo/demoMode.ts), so it never reads or writes the real profile: the
 * desktop app points Electron's userData there before anything reads it (index.ts, and desktopEntry.ts
 * for native Hermes), the web server uses it as its data dir (web/serverEntry.ts).
 *
 * Where the desktop app's folder is, is decided by two functions without Electron in them
 * (src/main/demo/dataDir.ts), tested here as they are. The entry files apply what they return. That
 * the entry files do so before the lock and the log file is not tested here: the started app is
 * (`npm run test:smoke:demo`).
 */

// serverEntry starts the web server when it is imported; these stand in for the server and the shim.
const web = vi.hoisted(() => ({ userDataPaths: [] as string[], serverDataDirs: [] as string[] }));
vi.mock('../../src/main/web/electronShim', () => ({
  setHeadlessUserDataPath: (dir: string) => {
    web.userDataPaths.push(dir);
  },
}));
vi.mock('../../src/main/web/WebServer', () => ({
  Sshs3WebServer: class {
    constructor(options: { dataDir: string }) {
      web.serverDataDirs.push(options.dataDir);
    }
    async start(): Promise<{ host: string; port: number }> {
      return { host: '127.0.0.1', port: 8080 };
    }
    async stop(): Promise<void> {}
  },
}));

describe('demoWorkspaceDir', () => {
  it('is demo-workspace inside the normal data dir: Electron userData, a portable data dir, the web data dir', () => {
    const bases = [
      path.join(os.homedir(), '.config', 'sshs3'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'sshs3'),
      path.join(path.dirname(process.execPath), 'data'),
      path.join(os.homedir(), '.sshs3-web-server'),
    ];
    for (const base of bases) {
      const demoDir = demoWorkspaceDir(base);
      expect(demoDir).toBe(path.join(base, 'demo-workspace'));
      expect(path.dirname(demoDir)).toBe(base);
      // desktopEntry and index.ts may both apply it: never a second level.
      expect(demoWorkspaceDir(demoDir)).toBe(demoDir);
    }
  });

  it('only treats a directory named exactly demo-workspace as already redirected', () => {
    const root = path.join(os.tmpdir(), 'sshs3-profiles');
    for (const name of ['demo-workspace-old', 'my-demo-workspace', 'demo']) {
      const base = path.join(root, name);
      expect(demoWorkspaceDir(base), name).toBe(path.join(base, 'demo-workspace'));
    }
  });
});

describe('the data folder of the desktop app (resolveUserDataDir, applied by index.ts)', () => {
  const home = path.join(os.homedir(), '.config', 'sshs3');
  const base = { demoMode: false, defaultDir: home, platform: 'linux' as NodeJS.Platform, execPath: '/opt/sshs3/sshs3', devServer: false, exists: () => false };

  it('is Electron\'s own folder for a normal start, and nothing is moved', () => {
    expect(resolveUserDataDir(base)).toEqual({ dir: home, demo: false });
  });

  it('is demo-workspace inside it in demo mode, with the logs kept there too', () => {
    const demo = resolveUserDataDir({ ...base, demoMode: true });
    expect(demo).toEqual({ dir: path.join(home, 'demo-workspace'), demo: true, logsDir: path.join(home, 'demo-workspace', 'logs') });
    // Never the real profile's folder, and not outside it: a demo reads and writes below it only.
    const normal = resolveUserDataDir(base);
    expect(demo.dir).not.toBe(normal.dir);
    expect(path.relative(normal.dir, demo.dir)).toBe('demo-workspace');
    expect(path.relative(demo.dir, demo.logsDir!)).toBe('logs');
  });

  it('gives a demo and a normal instance different folders in every kind of start, so each has its own lock', () => {
    // The single-instance lock is taken per data folder: two folders are two locks, and a demo runs beside the app.
    const starts = [base, { ...base, portableDir: '/media/stick/sshs3' }, { ...base, platform: 'win32' as NodeJS.Platform, exists: () => true }, { ...base, platform: 'darwin' as NodeJS.Platform }];
    for (const start of starts) {
      const normal = resolveUserDataDir(start);
      const demo = resolveUserDataDir({ ...start, demoMode: true });
      expect(demo.dir, JSON.stringify(start)).toBe(path.join(normal.dir, 'demo-workspace'));
      expect(normal.demo).toBe(false);
      expect(normal.logsDir).toBeUndefined();
    }
  });

  it('keeps a portable executable\'s data beside it, and its demo inside that', () => {
    const portable = { ...base, portableDir: '/media/stick/sshs3' };
    expect(resolveUserDataDir(portable).dir).toBe(path.join('/media/stick/sshs3', 'data'));
    expect(resolveUserDataDir({ ...portable, demoMode: true }).dir).toBe(path.join('/media/stick/sshs3', 'data', 'demo-workspace'));
    // The portable folder wins over a data folder beside the executable.
    expect(resolveUserDataDir({ ...portable, platform: 'win32', exists: () => true }).dir).toBe(path.join('/media/stick/sshs3', 'data'));
  });

  it('uses a data folder beside the executable on Windows when there is one, on a real disk', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sshs3-zip-'));
    try {
      const windows = { ...base, platform: 'win32' as NodeJS.Platform, execPath: path.join(dir, 'sshs3.exe'), exists: fs.existsSync };
      // No folder yet: Electron's own.
      expect(resolveUserDataDir(windows).dir).toBe(home);
      await fsp.mkdir(path.join(dir, 'data'));
      expect(resolveUserDataDir(windows).dir).toBe(path.join(dir, 'data'));
      expect(resolveUserDataDir({ ...windows, demoMode: true }).dir).toBe(path.join(dir, 'data', 'demo-workspace'));
      // Started against the dev server the executable is Electron's own: its folder is not looked at.
      expect(resolveUserDataDir({ ...windows, devServer: true }).dir).toBe(home);
      // And on no other system.
      expect(resolveUserDataDir({ ...windows, platform: 'linux' }).dir).toBe(home);
      expect(resolveUserDataDir({ ...windows, platform: 'darwin' }).dir).toBe(home);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the data folder of the native Hermes window (nativeHermesDataDirs, applied by desktopEntry.ts)', () => {
  const appData = path.join(os.homedir(), '.config');

  it('is sshs3 inside the application data, a portable executable\'s data, or the folder somebody chose', () => {
    expect(nativeHermesDataDirs({ demoMode: false, appData })).toEqual({ userData: path.join(appData, 'sshs3'), hermesHome: path.join(appData, 'sshs3', 'hermes-native') });
    expect(nativeHermesDataDirs({ demoMode: false, appData, portableDir: '/media/stick/sshs3' }).userData).toBe(path.join('/media/stick/sshs3', 'data'));
    expect(nativeHermesDataDirs({ demoMode: false, appData, portableDir: '/media/stick/sshs3', userDataOverride: '/srv/sshs3-data' }).userData).toBe('/srv/sshs3-data');
  });

  it('keeps a demo\'s data, Hermes\' included, in demo-workspace inside it', () => {
    for (const input of [{ appData }, { appData, portableDir: '/media/stick/sshs3' }, { appData, userDataOverride: '/srv/sshs3-data' }]) {
      const normal = nativeHermesDataDirs({ ...input, demoMode: false });
      const demo = nativeHermesDataDirs({ ...input, demoMode: true });
      expect(demo.userData).toBe(path.join(normal.userData, 'demo-workspace'));
      // Hermes' own folder is inside the demo's, never inside the real profile's.
      expect(demo.hermesHome).toBe(path.join(demo.userData, 'hermes-native'));
      expect(demo.hermesHome.startsWith(normal.hermesHome)).toBe(false);
    }
  });

  it('is left as it is by the regular window\'s decision, which runs after it', () => {
    // desktopEntry.ts sets the folder, then index.ts decides again from what is set: no second level.
    for (const demoMode of [true, false]) {
      const first = nativeHermesDataDirs({ demoMode, appData });
      const second = resolveUserDataDir({ demoMode, defaultDir: first.userData, platform: 'linux', execPath: '/opt/sshs3/sshs3', devServer: false, exists: () => false });
      expect(second.dir).toBe(first.userData);
    }
  });
});

describe('the web server (serverEntry.ts)', () => {
  const VARIABLES = ['SSHS3_DATA_DIR', 'SSHS3_DEMO', 'SSHS3_DEMO_WORKSPACE'] as const;
  const savedArgv = [...process.argv];
  const savedEnv = new Map(VARIABLES.map((name) => [name, process.env[name]] as const));
  const signals = process as EventEmitter;
  const signalListeners = (signal: 'SIGINT' | 'SIGTERM') => signals.listeners(signal) as ((...args: any[]) => void)[];
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
    process.argv = [...savedArgv];
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    web.userDataPaths.length = 0;
    web.serverDataDirs.length = 0;
  });

  /**
   * Runs serverEntry the way `node dist-web/server.mjs <args>` does, with SSHS3_DATA_DIR set to a fresh
   * directory. Returns that directory and the startup banner.
   */
  async function startServer(args: string[], env: Record<string, string> = {}): Promise<{ base: string; banner: string }> {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'sshs3-web-demo-'));
    cleanups.push(() => fsp.rm(base, { recursive: true, force: true }));
    process.argv = ['/usr/bin/node', '/opt/sshs3/dist-web/server.mjs', ...args];
    delete process.env.SSHS3_DEMO;
    delete process.env.SSHS3_DEMO_WORKSPACE;
    process.env.SSHS3_DATA_DIR = base;
    Object.assign(process.env, env);

    // main() registers SIGINT/SIGTERM handlers once the server runs; remove them again afterwards.
    const before = { SIGINT: signalListeners('SIGINT'), SIGTERM: signalListeners('SIGTERM') };
    cleanups.push(() => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of signalListeners(signal)) {
          if (!before[signal].includes(listener)) signals.removeListener(signal, listener);
        }
      }
    });
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    // A failed start would end the test process; let it fail the test instead (its error goes to stderr).
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    vi.resetModules();
    await import('../../src/main/web/serverEntry');
    await vi.waitFor(() => expect(output.join('')).toContain('Demo Mode:'));
    return { base, banner: output.join('') };
  }

  it('keeps a demo server (--demo) in <dataDir>/demo-workspace', async () => {
    const { base, banner } = await startServer(['--demo']);
    const demoDir = path.join(base, 'demo-workspace');
    expect(web.userDataPaths).toEqual([demoDir]);
    expect(web.serverDataDirs).toEqual([demoDir]);
    expect(fs.statSync(demoDir).isDirectory()).toBe(true);
    expect(banner).toContain(demoDir);
    expect(banner).toMatch(/Demo Mode:\s+on\b/);
  });

  it('does the same for SSHS3_DEMO=1', async () => {
    const { base, banner } = await startServer([], { SSHS3_DEMO: '1' });
    const demoDir = path.join(base, 'demo-workspace');
    expect(web.userDataPaths).toEqual([demoDir]);
    expect(web.serverDataDirs).toEqual([demoDir]);
    expect(banner).toMatch(/Demo Mode:\s+on\b/);
  });

  it('uses the data dir itself without demo mode, and creates no demo workspace', async () => {
    const { base, banner } = await startServer([]);
    expect(web.userDataPaths).toEqual([base]);
    expect(web.serverDataDirs).toEqual([base]);
    expect(fs.existsSync(path.join(base, 'demo-workspace'))).toBe(false);
    expect(banner).toMatch(/Demo Mode:\s+off\b/);
  });
});
