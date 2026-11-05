import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp' },
  dialog: {},
  shell: {},
}));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { registerGeneralHandlers, type GeneralHost } from '../../src/main/ipc/generalHandlers';
import { registerStorageHandlers, type StorageHost } from '../../src/main/ipc/storageHandlers';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value });

describe('Windows attribute IPC handlers', () => {
  const handlers = new Map<string, Handler>();
  const providers = new Map<string, unknown>();

  beforeEach(() => {
    handlers.clear();
    providers.clear();
    registerStorageHandlers({
      registerHandler: (channel: string, h: Handler) => handlers.set(channel, h),
      storageRegistry: { get: (id: string) => providers.get(id) },
    } as unknown as StorageHost);
  });

  const get = (...args: unknown[]) => handlers.get(IPC_CHANNELS.STORAGE_GET_WIN_ATTRIBUTES)!({}, ...args);
  const set = (...args: unknown[]) => handlers.get(IPC_CHANNELS.STORAGE_SET_WIN_ATTRIBUTES)!({}, ...args);

  it('passes valid requests to the provider', async () => {
    const attrs = { readOnly: true, hidden: false, system: false, archive: false };
    const provider = { getWinAttributes: vi.fn().mockResolvedValue(attrs), setWinAttributes: vi.fn().mockResolvedValue(undefined) };
    providers.set('local', provider);

    await expect(get('local', 'C:\\x')).resolves.toBe(attrs);
    await set('local', 'C:\\x', { hidden: true }, true);
    expect(provider.setWinAttributes).toHaveBeenCalledWith('C:\\x', { hidden: true }, true);
  });

  it('keeps only boolean flags and treats a non-true recursive value as false', async () => {
    const provider = { setWinAttributes: vi.fn().mockResolvedValue(undefined) };
    providers.set('local', provider);
    await set('local', 'C:\\x', { readOnly: 'yes', hidden: false, constructor: true, extra: true }, 'true');
    expect(provider.setWinAttributes).toHaveBeenCalledWith('C:\\x', { hidden: false }, false);
  });

  it('rejects arguments that are not non-empty strings before touching a provider', async () => {
    providers.set('local', { getWinAttributes: vi.fn(), setWinAttributes: vi.fn() });
    await expect(get(5, 'C:\\x')).rejects.toThrow('Invalid argument: providerId');
    await expect(get('local', undefined)).rejects.toThrow('Invalid argument: remotePath');
    await expect(set('local', '', {})).rejects.toThrow('Invalid argument: remotePath');
    await expect(set({}, 'C:\\x', {})).rejects.toThrow('Invalid argument: providerId');
  });

  it('rejects an unknown provider and one without Windows attributes', async () => {
    await expect(get('nope', 'C:\\x')).rejects.toThrow('Storage provider not found');
    providers.set('s3', {});
    await expect(get('s3', 'x')).rejects.toThrow('does not support Windows attributes');
    await expect(set('s3', 'x', {})).rejects.toThrow('does not support Windows attributes');
  });
});

describe('APP_OPEN_ELEVATED_SHELL', () => {
  let open: Handler;

  beforeEach(() => {
    const handlers = new Map<string, Handler>();
    registerGeneralHandlers({
      registerHandler: (channel: string, h: Handler) => handlers.set(channel, h),
    } as unknown as GeneralHost);
    open = handlers.get(IPC_CHANNELS.APP_OPEN_ELEVATED_SHELL)!;
    setPlatform('win32');
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', origPlatform);
    vi.mocked(execFile).mockReset();
  });

  const succeed = () =>
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (...x: unknown[]) => void) => cb(null, { stdout: '', stderr: '' })) as never);

  it('is only available on Windows', async () => {
    setPlatform('linux');
    await expect(open({}, 'cmd')).rejects.toThrow('only available on Windows');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('starts a whitelisted shell through a fixed PowerShell command', async () => {
    succeed();
    await expect(open({}, 'pwsh')).resolves.toEqual({ started: true });
    const [file, args] = vi.mocked(execFile).mock.calls[0] as unknown as [string, string[]];
    expect(file).toBe('powershell.exe');
    expect(args.at(-1)).toContain("-FilePath 'pwsh.exe'");
    expect(args.at(-1)).toContain('-Verb RunAs');
  });

  it('refuses anything outside the whitelist without starting a process', async () => {
    succeed();
    for (const value of ['wsl', 'constructor', '__proto__', 'cmd.exe & calc', 7, undefined]) {
      await expect(open({}, value)).rejects.toThrow('Unsupported shell for elevation');
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports a declined UAC prompt as not started, in any language', async () => {
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (...x: unknown[]) => void) =>
      cb(Object.assign(new Error('Command failed'), { code: 2, stderr: 'Åtgärden avbröts av användaren' }))) as never);
    await expect(open({}, 'cmd')).resolves.toEqual({ started: false });
  });

  it('rethrows other failures', async () => {
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: unknown, cb: (...x: unknown[]) => void) =>
      cb(Object.assign(new Error('boom'), { code: 1, stderr: 'canceled' }))) as never);
    await expect(open({}, 'cmd')).rejects.toThrow('boom');
  });
});
