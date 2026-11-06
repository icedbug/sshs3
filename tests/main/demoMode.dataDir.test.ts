import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { demoWorkspaceDir } from '../../src/main/demo/demoMode';

/**
 * A demo process keeps all of its state in `demo-workspace` inside the normal data directory
 * (demoWorkspaceDir in src/main/demo/demoMode.ts), so it never reads or writes the real profile: the
 * desktop app points Electron's userData there before anything reads it (index.ts, and desktopEntry.ts
 * for native Hermes), the web server uses it as its data dir (web/serverEntry.ts).
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

const SRC_MAIN = path.join(__dirname, '../../src/main');

/** A main-process source file, with LF line endings whatever the checkout uses. */
function mainSource(file: string): string {
  return fs.readFileSync(path.join(SRC_MAIN, file), 'utf8').replace(/\r\n/g, '\n');
}

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

describe('the desktop app (index.ts)', () => {
  /** Offsets in index.ts where the demo data dir is derived from userData and where userData is set to it. */
  function demoRedirect(index: string): { derived: number; applied: number } {
    const derived = index.indexOf("demoWorkspaceDir(app.getPath('userData'))");
    expect(derived, "index.ts derives the demo data dir from app.getPath('userData')").toBeGreaterThan(-1);
    const applied = index.indexOf("app.setPath('userData'", derived);
    expect(applied, 'index.ts points userData at the demo data dir').toBeGreaterThan(derived);
    return { derived, applied };
  }

  it('moves userData into the demo workspace before the lock, the log file and the stores read it', () => {
    const index = mainSource('index.ts');
    const { derived, applied } = demoRedirect(index);
    // The portable redirects come first, so the demo workspace is inside them; nothing re-points userData later.
    expect(index.lastIndexOf("app.setPath('userData'"), 'the demo redirect is the last userData change').toBe(applied);
    for (const reader of ['app.requestSingleInstanceLock()', 'configureLogging(', "'.gpu-crash-detected'", 'new IpcBridge(']) {
      const at = index.indexOf(reader);
      expect(at, `${reader} is in index.ts`).toBeGreaterThan(-1);
      expect(at, `${reader} comes after the demo redirect`).toBeGreaterThan(applied);
    }
    for (const read of index.matchAll(/\bgetPath\('(?:userData|logs)'\)/g)) {
      const at = read.index ?? -1;
      if (at > derived && at < applied) continue; // the redirect's own read
      expect(at, `${read[0]} at offset ${at} comes after the demo redirect`).toBeGreaterThan(applied);
    }
  });

  it('takes the single-instance lock in demo mode too, so the lock is per data dir', () => {
    const index = mainSource('index.ts');
    const { applied } = demoRedirect(index);
    const redirectEnd = index.indexOf('\n}\n', applied);
    const lock = index.indexOf('app.requestSingleInstanceLock()');
    expect(redirectEnd).toBeGreaterThan(applied);
    expect(lock).toBeGreaterThan(redirectEnd);
    // Nothing between the redirect and the lock looks at demo mode, so a demo instance is not exempt.
    expect(index.slice(redirectEnd, lock)).not.toMatch(/isDemoMode|demoMode|SSHS3_DEMO|--demo/);
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
