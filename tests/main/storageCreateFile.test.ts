import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { registerStorageHandlers, type StorageHost } from '../../src/main/ipc/storageHandlers';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

describe('STORAGE_CREATE_FILE', () => {
  let dir: string;
  let createFile: Handler;
  const providers = new Map<string, unknown>();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-createfile-'));
    providers.clear();
    providers.set('local', new LocalStorageProvider({ id: 'local' }));
    const handlers = new Map<string, Handler>();
    registerStorageHandlers({
      registerHandler: (channel: string, handler: Handler) => handlers.set(channel, handler),
      storageRegistry: { get: (id: string) => providers.get(id) },
    } as unknown as StorageHost);
    createFile = handlers.get(IPC_CHANNELS.STORAGE_CREATE_FILE)!;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates an empty file', async () => {
    await createFile({}, 'local', path.join(dir, 'new.md'));
    expect(fs.readFileSync(path.join(dir, 'new.md'), 'utf8')).toBe('');
  });

  it('refuses an existing file and leaves its content alone', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'keep me');
    await expect(createFile({}, 'local', path.join(dir, 'a.txt'))).rejects.toThrow('"a.txt" already exists');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('keep me');
  });

  // Windows needs a privilege to create symlinks and resolves a dangling one differently when creating a file.
  it.skipIf(process.platform === 'win32')('refuses a dangling symlink instead of creating the file it points to', async () => {
    const target = path.join(dir, 'target.txt');
    fs.symlinkSync(target, path.join(dir, 'link.txt'));
    await expect(createFile({}, 'local', path.join(dir, 'link.txt'))).rejects.toThrow('"link.txt" already exists');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('names the file, not the whole path, in the message for POSIX and Windows paths', async () => {
    providers.set('fake', { stat: vi.fn().mockResolvedValue({}), writeFile: vi.fn() });
    await expect(createFile({}, 'fake', '/home/me/notes.txt')).rejects.toThrow('"notes.txt" already exists');
    await expect(createFile({}, 'fake', 'C:\\Users\\me\\notes.txt')).rejects.toThrow('"notes.txt" already exists');
  });

  it('rejects bad arguments and unknown or read-only providers', async () => {
    await expect(createFile({}, 5, 'x')).rejects.toThrow('Invalid arguments');
    await expect(createFile({}, 'local', 'a\0b')).rejects.toThrow('Invalid arguments');
    await expect(createFile({}, 'nope', path.join(dir, 'x'))).rejects.toThrow('Storage provider not found');
    providers.set('ro', { stat: vi.fn() });
    await expect(createFile({}, 'ro', path.join(dir, 'x'))).rejects.toThrow('not supported');
  });
});
