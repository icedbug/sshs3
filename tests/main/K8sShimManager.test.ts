import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdtempSync: vi.fn(),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const customFs = {
    ...actual,
    existsSync: (...args: any[]) => mockFs.existsSync(...args),
    mkdirSync: (...args: any[]) => mockFs.mkdirSync(...args),
    writeFileSync: (...args: any[]) => mockFs.writeFileSync(...args),
    mkdtempSync: (...args: any[]) => mockFs.mkdtempSync(...args),
  };
  return {
    ...customFs,
    default: customFs,
  };
});

import { K8sShimManager } from '../../src/main/services/K8sShimManager';

describe('K8sShimManager', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFs.existsSync.mockReset();
    mockFs.mkdirSync.mockReset();
    mockFs.writeFileSync.mockReset();
    mockFs.mkdtempSync.mockReset();
    (K8sShimManager as unknown as { fallbackBinDir?: string }).fallbackBinDir = undefined;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('getShimDir returns ~/.sshs3/bin', () => {
    const expected = path.join(os.homedir(), '.sshs3', 'bin');
    expect(K8sShimManager.getShimDir()).toBe(expected);
  });

  it('creates directory and writes shell script shim on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockFs.existsSync.mockImplementation((p: string) => {
      // binDir does not exist yet; ocShimCli.cjs exists
      if (p.includes('.sshs3')) return false;
      return true;
    });

    const binDir = K8sShimManager.ensureShim();
    expect(binDir).toBe(K8sShimManager.getShimDir());

    // Verified directory creation
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(binDir, { recursive: true, mode: 0o755 });

    // Verified shell script creation
    const shPath = path.join(binDir, 'oc');
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      shPath,
      expect.stringContaining('#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\n'),
      { encoding: 'utf8', mode: 0o755 }
    );
  });

  describe('when ~/.sshs3/bin cannot be created', () => {
    const fallback = path.join(os.tmpdir(), 'sshs3-bin-Ab12Cd');

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      mockFs.existsSync.mockImplementation((p: string) => (p.includes('.sshs3') ? false : true));
      mockFs.mkdirSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      mockFs.mkdtempSync.mockReturnValue(fallback);
    });

    it('uses an unpredictable private directory, not a fixed name in the shared temp dir', () => {
      expect(K8sShimManager.ensureShim()).toBe(fallback);
      expect(mockFs.mkdtempSync).toHaveBeenCalledWith(path.join(os.tmpdir(), 'sshs3-bin-'));
      // Nothing is created at the old, pre-creatable path.
      expect(mockFs.mkdirSync).not.toHaveBeenCalledWith(path.join(os.tmpdir(), 'sshs3-bin'), expect.anything());
    });

    it('still writes the oc shim into the fallback directory', () => {
      K8sShimManager.ensureShim();
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        path.join(fallback, 'oc'),
        expect.stringContaining('#!/bin/sh'),
        { encoding: 'utf8', mode: 0o755 }
      );
    });

    it('reuses the same fallback directory for later terminals while it exists', () => {
      mockFs.existsSync.mockImplementation((p: string) => (p.includes('.sshs3') ? false : true));
      expect(K8sShimManager.ensureShim()).toBe(fallback);
      expect(K8sShimManager.ensureShim()).toBe(fallback);
      expect(mockFs.mkdtempSync).toHaveBeenCalledTimes(1);
    });

    it('creates a new one if the temp cleaner removed it', () => {
      K8sShimManager.ensureShim();
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdtempSync.mockReturnValue(`${fallback}2`);
      expect(K8sShimManager.ensureShim()).toBe(`${fallback}2`);
    });
  });

  it('writes cmd and ps1 scripts on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockFs.existsSync.mockReturnValue(true);

    const binDir = K8sShimManager.ensureShim();
    expect(binDir).toBe(K8sShimManager.getShimDir());

    const cmdPath = path.join(binDir, 'oc.cmd');
    const ps1Path = path.join(binDir, 'oc.ps1');

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      cmdPath,
      expect.stringContaining('@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n'),
      { encoding: 'utf8' }
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      ps1Path,
      expect.stringContaining('$env:ELECTRON_RUN_AS_NODE = "1"\r\n'),
      { encoding: 'utf8' }
    );
  });

  it('handles writeFileSync throwing errors gracefully', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.writeFileSync.mockImplementation(() => {
      throw new Error('EROFS: read-only file system');
    });

    expect(() => K8sShimManager.ensureShim()).not.toThrow();
  });

  it('handles writeFileSync throwing errors gracefully on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockFs.existsSync.mockReturnValue(true);
    mockFs.writeFileSync.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });

    expect(() => K8sShimManager.ensureShim()).not.toThrow();
  });

  it('resolves srcPath when distPath is not found', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p.endsWith('distPath')) return false;
      return true;
    });

    expect(() => K8sShimManager.ensureShim()).not.toThrow();
  });
});
