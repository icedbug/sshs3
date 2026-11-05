import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DragOutService } from '../../src/main/dragout/DragOutService';
import { TransferQueue } from '../../src/main/transfer/TransferQueue';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';

describe('DragOutService with the real transfer queue', () => {
  it('stages a file and a nested folder', async () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-dragout-src-'));
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-dragout-dst-'));
    fs.mkdirSync(path.join(src, 'tree/sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'tree/sub/deep.txt'), 'deep');
    fs.writeFileSync(path.join(src, 'file.txt'), 'hello');

    const local = new LocalStorageProvider({ id: 'local', name: 'Local' });
    const service = new DragOutService(
      { getSource: (id) => (id === 'src' ? local : undefined), getLocal: async () => local, queue: new TransferQueue() },
      base
    );
    const [file, tree] = await service.prepare('src', [path.join(src, 'file.txt'), path.join(src, 'tree')]);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
    expect(fs.readFileSync(path.join(tree, 'sub/deep.txt'), 'utf8')).toBe('deep');

    await service.dispose();
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  });
});
