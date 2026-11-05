import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMuxControlPath, createMuxControlPath } from '../../src/main/ssh/muxControlPath';

describe('buildMuxControlPath', () => {
  it('names the socket after the id inside the given folder', () => {
    expect(buildMuxControlPath('/run/user/1000/sshs3', 'abcd1234')).toBe(path.join('/run/user/1000/sshs3', 's3m-abcd1234.sock'));
  });

  it('shortens the name when the path plus the temp suffix ssh adds while binding would not fit', () => {
    const dir = `/${'d'.repeat(70)}`;
    const long = buildMuxControlPath(dir, 'abcd1234')!;
    expect(long).toBeDefined();
    expect(long.length).toBeLessThanOrEqual(dir.length + 1 + 'm-abcd.sock'.length);
    expect(Buffer.byteLength(long) + 17).toBeLessThan(104);
  });

  it('gives up (no multiplexing) when even the shortest name does not fit', () => {
    expect(buildMuxControlPath(`/${'d'.repeat(100)}`, 'abcd1234')).toBeUndefined();
  });
});

describe.skipIf(process.platform === 'win32')('createMuxControlPath', () => {
  let runtime: string;
  const savedRuntime = process.env.XDG_RUNTIME_DIR;
  beforeEach(() => {
    runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-runtime-'));
    process.env.XDG_RUNTIME_DIR = runtime;
  });
  afterEach(() => {
    if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = savedRuntime;
    fs.rmSync(runtime, { recursive: true, force: true });
  });

  it('puts the socket in the private app folder (0700), not directly in the shared temp folder', async () => {
    const controlPath = await createMuxControlPath();

    expect(controlPath).toBeDefined();
    expect(path.dirname(controlPath!)).toBe(path.join(runtime, 'sshs3'));
    expect(path.dirname(controlPath!)).not.toBe(os.tmpdir());
    expect(fs.statSync(path.dirname(controlPath!)).mode & 0o777).toBe(0o700);
  });

  it('uses a fresh name each time', async () => {
    expect(await createMuxControlPath()).not.toBe(await createMuxControlPath());
  });

  it('gives up multiplexing instead of using a folder others can reach', async () => {
    const dir = path.join(runtime, 'sshs3');
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.chmodSync(dir, 0o777);

    expect(await createMuxControlPath()).toBeUndefined();
  });
});
