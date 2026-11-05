import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createFromBuffer: () => ({ isEmpty: () => false }) },
}));

import { validateDragOutPaths, registerDragOutHandlers } from '../../src/main/ipc/dragOutHandlers';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

describe('dragOutHandlers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-dragout-test-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps existing absolute files and directories only', async () => {
    const result = await validateDragOutPaths([file, dir, 'relative.txt', path.join(dir, 'missing'), 'a\0b', 42, '']);
    expect(result).toEqual([file, dir]);
  });

  it('rejects non-array input', async () => {
    expect(await validateDragOutPaths('/etc/passwd')).toEqual([]);
    expect(await validateDragOutPaths(null)).toEqual([]);
  });

  it('starts a native drag for valid paths and refuses empty ones', async () => {
    let handler: (event: unknown, paths: unknown) => Promise<boolean> = async () => false;
    registerDragOutHandlers({
      registerHandler: ((channel: string, h: typeof handler) => {
        if (channel === IPC_CHANNELS.DRAG_OUT_START) handler = h;
      }) as never,
      dragOutService: {} as never,
    });
    const startDrag = vi.fn();
    expect(await handler({ sender: { startDrag } }, [file])).toBe(true);
    expect(startDrag).toHaveBeenCalledWith(expect.objectContaining({ file, files: [file] }));
    startDrag.mockClear();
    expect(await handler({ sender: { startDrag } }, ['nope'])).toBe(false);
    expect(startDrag).not.toHaveBeenCalled();
  });
});
