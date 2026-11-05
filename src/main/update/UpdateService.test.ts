import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '1.0.0' } }));
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }));

import { UpdateService, sanitizeUpdateError, type UpdaterLike } from './UpdateService';
import type { UpdateState } from '../../shared/types/update';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update');
    return null;
  });
  downloadUpdate = vi.fn(async () => null);
  quitAndInstall = vi.fn();
}

function create(opts: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const updater = new FakeUpdater();
  const send = vi.fn<(s: UpdateState) => void>();
  const service = new UpdateService({
    updater: updater as unknown as UpdaterLike,
    getAutoCheck: () => true,
    send,
    platform: 'linux',
    paintDelayMs: 0,
    ...opts,
  });
  return { updater, send, service };
}

describe('UpdateService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('configures the updater conservatively', () => {
    const { updater } = create();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
  });

  it('is unsupported in dev, on Windows and when disabled by the administrator', async () => {
    const dev = create({ isPackaged: false });
    expect(dev.service.getState()).toMatchObject({ status: 'unsupported', unsupportedReason: 'dev' });
    await dev.service.check();
    expect(dev.updater.checkForUpdates).not.toHaveBeenCalled();

    const win = create({ isPackaged: true, platform: 'win32', isNsisInstall: true });
    expect(win.service.getState()).toMatchObject({ status: 'unsupported', unsupportedReason: 'windows-unsigned' });
    win.service.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 60 * 1000);
    expect(win.updater.checkForUpdates).not.toHaveBeenCalled();

    const msi = create({ isPackaged: true, platform: 'win32', isNsisInstall: false });
    expect(msi.service.getState()).toMatchObject({ status: 'unsupported', unsupportedReason: 'not-installer' });
    msi.service.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 60 * 1000);
    expect(msi.updater.checkForUpdates).not.toHaveBeenCalled();

    const off = create({ isPackaged: true, platform: 'linux', disabled: true });
    expect(off.service.getState()).toMatchObject({ status: 'unsupported', unsupportedReason: 'disabled' });
    off.service.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 60 * 1000);
    expect(off.updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('walks available -> downloading -> ready -> install', async () => {
    const { updater, service, send } = create();
    await service.check();
    updater.emit('update-available', { version: '2.0.0' });
    expect(service.getState()).toMatchObject({ status: 'available', version: '2.0.0' });

    await service.download();
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    updater.emit('download-progress', { percent: 41.6 });
    expect(service.getState()).toMatchObject({ status: 'downloading', progress: 42 });
    updater.emit('update-downloaded', { version: '2.0.0' });
    expect(service.getState().status).toBe('ready');

    await service.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, false);
    expect(send).toHaveBeenCalled();
  });

  it('shows the installing state before quitAndInstall and recovers to ready on failure', async () => {
    const { updater, service, send } = create();
    updater.emit('update-downloaded', { version: '2.0.0' });
    updater.quitAndInstall.mockImplementationOnce(() => {
      expect(service.getState().status).toBe('installing');
      updater.emit('error', new Error('polkit dismissed'));
    });
    await service.install();
    expect(service.getState()).toMatchObject({ status: 'ready', error: 'polkit dismissed' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: 'installing' }));
  });

  it('does not download or install out of order', async () => {
    const { updater, service } = create();
    await service.download();
    await service.install();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not install when the quit confirmation is cancelled', async () => {
    const confirmQuit = vi.fn(async () => false);
    const { updater, service } = create({ confirmQuit });
    updater.emit('update-available', { version: '2.0.0' });
    updater.emit('update-downloaded', { version: '2.0.0' });
    await service.install();
    expect(confirmQuit).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    confirmQuit.mockResolvedValueOnce(true);
    await service.install();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('returns to available when the download fails or never completes', async () => {
    const { updater, service } = create();
    updater.emit('update-available', { version: '2.0.0' });
    updater.downloadUpdate.mockRejectedValueOnce(new Error('network down'));
    await service.download();
    expect(service.getState()).toMatchObject({ status: 'available', version: '2.0.0', error: 'network down' });

    await service.download();
    expect(service.getState()).toMatchObject({ status: 'available', error: 'Download did not complete' });
  });

  it('reports an error when an inactive updater emits nothing on check', async () => {
    const { updater, service } = create();
    updater.checkForUpdates.mockImplementationOnce(async () => null);
    await service.check();
    expect(service.getState().status).toBe('error');
  });

  it('does not re-check while an update is already offered', async () => {
    const { updater, service } = create();
    updater.emit('update-available', { version: '2.0.0' });
    await service.check();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('reports errors as a single short line', async () => {
    const { updater, service } = create();
    updater.checkForUpdates.mockRejectedValueOnce(new Error('boom\n    at secret/stack'));
    await service.check();
    expect(service.getState()).toMatchObject({ status: 'error', error: 'boom' });
    expect(sanitizeUpdateError(new Error('x'.repeat(500))).length).toBe(200);
    expect(sanitizeUpdateError(new Error(''))).toBe('Update failed');
  });

  it('polls after the initial delay, honours the setting, and stops on dispose', async () => {
    let enabled = true;
    const { updater, service } = create({
      getAutoCheck: () => enabled,
      initialDelayMs: 1000,
      pollIntervalMs: 5000,
    });
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit('update-not-available');

    enabled = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    enabled = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    service.dispose();
    updater.emit('update-not-available');
    await vi.advanceTimersByTimeAsync(20000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('skips checks while busy', async () => {
    const { updater, service } = create();
    updater.emit('update-available', { version: '2.0.0' });
    await service.download();
    await service.check();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('invokes relaunchOnLinux and sets autoRunAppAfterInstall to false on Linux install', async () => {
    const relaunchOnLinux = vi.fn();
    const { updater, service } = create({ platform: 'linux', relaunchOnLinux });
    updater.emit('update-downloaded', { version: '2.0.0' });
    await service.install();
    expect(relaunchOnLinux).toHaveBeenCalledOnce();
    expect((updater as any).autoRunAppAfterInstall).toBe(false);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, false);
  });

  it('stops the Linux relaunch helper when the install fails or is cancelled, so a later quit does not restart the app', async () => {
    const cancel = vi.fn();
    const relaunchOnLinux = vi.fn(() => ({ cancel }));
    const { updater, service } = create({ platform: 'linux', relaunchOnLinux });
    updater.emit('update-downloaded', { version: '2.0.0' });
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit('error', new Error('polkit dismissed'));
    });
    await service.install();
    expect(service.getState().status).toBe('ready');
    expect(cancel).toHaveBeenCalledOnce();

    // A second attempt starts a new helper, and an install that goes through leaves it running.
    await service.install();
    expect(relaunchOnLinux).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('stops the relaunch helper and stays retryable when quitAndInstall throws', async () => {
    const cancel = vi.fn();
    const relaunchOnLinux = vi.fn(() => ({ cancel }));
    const { updater, service } = create({ platform: 'linux', relaunchOnLinux });
    updater.emit('update-downloaded', { version: '2.0.0' });
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    await expect(service.install()).rejects.toThrow('spawn failed');
    expect(cancel).toHaveBeenCalledOnce();
    // Not stuck on the installing overlay: the user can try again.
    expect(service.getState()).toMatchObject({ status: 'ready', error: 'spawn failed' });
    await service.install();
    expect(relaunchOnLinux).toHaveBeenCalledTimes(2);
  });

  it('calls quitAndInstall(false, true) on non-Linux platforms', async () => {
    const relaunchOnLinux = vi.fn();
    const { updater, service } = create({ platform: 'darwin', relaunchOnLinux });
    updater.emit('update-downloaded', { version: '2.0.0' });
    await service.install();
    expect(relaunchOnLinux).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
});
