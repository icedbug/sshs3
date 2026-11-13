import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileEditorService } from '../../src/main/editor/FileEditorService';
import { StorageRegistry } from '../../src/main/storage/StorageRegistry';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';
import type { ExternalFileStatusEvent } from '../../src/shared/types/ipc';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let tempBaseDir: string;
let registry: StorageRegistry;
let shell: { openPath: ReturnType<typeof vi.fn<(p: string) => Promise<string>>> };

beforeEach(async () => {
  tempBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rest-editor-'));
  registry = new StorageRegistry();
  shell = { openPath: vi.fn<(p: string) => Promise<string>>().mockResolvedValue('') };
});

afterEach(async () => {
  await fsp.rm(tempBaseDir, { recursive: true, force: true });
});

describe('Open in External Editor on a local executable', () => {
  it('refuses a local executable type instead of handing it to the OS to run', async () => {
    const localDir = path.join(tempBaseDir, 'local');
    await fsp.mkdir(localDir);
    await fsp.writeFile(path.join(localDir, 'setup.exe'), 'MZ');
    await fsp.writeFile(path.join(localDir, 'Tool.desktop'), '[Desktop Entry]');
    registry.register(new LocalStorageProvider({ id: 'local-x', name: 'Local', basePath: localDir }));
    const service = new FileEditorService({ shell, baseTempDir: path.join(tempBaseDir, 'tmp') });

    await expect(service.openInExternalEditor(registry, 'local-x', 'setup.exe')).rejects.toThrow(/would be executed/);
    await expect(service.openInExternalEditor(registry, 'local-x', 'Tool.desktop')).rejects.toThrow(/would be executed/);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(service.getActiveSessions()).toEqual([]);
  });

  it('still opens an ordinary local text file', async () => {
    const localDir = path.join(tempBaseDir, 'local');
    await fsp.mkdir(localDir);
    await fsp.writeFile(path.join(localDir, 'notes.txt'), 'hi');
    registry.register(new LocalStorageProvider({ id: 'local-ok', name: 'Local', basePath: localDir }));
    const service = new FileEditorService({ shell, baseTempDir: path.join(tempBaseDir, 'tmp') });

    await service.openInExternalEditor(registry, 'local-ok', 'notes.txt');
    expect(shell.openPath).toHaveBeenCalledWith(path.join(localDir, 'notes.txt'));
    await service.dispose();
  });
});

describe('dispose uploads a save that is still waiting', () => {
  function remote(fail: boolean) {
    const uploads: string[] = [];
    registry.register({
      id: 'sftp-d',
      name: 'SFTP',
      type: 'sftp',
      createReadStream: vi.fn().mockImplementation(() => Readable.from([Buffer.from('v0')])),
      createWriteStream: vi.fn().mockImplementation(async () => {
        if (fail) throw new Error('Permission denied');
        const chunks: Buffer[] = [];
        return new Writable({
          write(chunk, _enc, cb) {
            chunks.push(chunk as Buffer);
            cb();
          },
          final(cb) {
            uploads.push(Buffer.concat(chunks).toString('utf8'));
            cb();
          },
        });
      }),
    } as any);
    return uploads;
  }

  async function saveThenDispose() {
    // A long debounce: without a flush, the save would still be waiting when dispose runs.
    const service = new FileEditorService({ shell, baseTempDir: path.join(tempBaseDir, 'tmp'), uploadDebounceMs: 5000 });
    const events: ExternalFileStatusEvent[] = [];
    const { localPath } = await service.openInExternalEditor(registry, 'sftp-d', '/etc/app.ini', (e) => events.push(e));
    await sleep(40);
    await fsp.writeFile(localPath, 'saved right before quitting');
    await sleep(60); // let the file watch see the save
    await service.dispose();
    return events;
  }

  it('uploads the pending save before cleaning up', async () => {
    const uploads = remote(false);
    const events = await saveThenDispose();
    expect(uploads).toEqual(['saved right before quitting']);
    expect(events.map((e) => e.status)).toEqual(['uploaded']);
  });

  it('reports a failed upload of the pending save instead of dropping it silently', async () => {
    remote(true);
    const events = await saveThenDispose();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'error', error: 'Permission denied', remotePath: '/etc/app.ini' });
  });
});
