import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { takeLock } from '../src/lock';

describe('locks on a lab and on a campaign', () => {
  it('one command at a time; a lock left by a process that has ended is taken over', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-lock-'));
    try {
      const file = path.join(dir, 'lab-9.lock');
      const release = await takeLock(file, 'lab 9 (validate)');
      await expect(takeLock(file, 'lab 9 (campaign pass1)')).rejects.toThrow(/in use by process \d+ \(lab 9 \(validate\)\)/);
      await release();
      const again = await takeLock(file, 'lab 9 (campaign pass1)');
      await again();
      // A process that has ended left its lock behind.
      const gone = spawn('true');
      await once(gone, 'exit');
      await fs.writeFile(file, JSON.stringify({ pid: gone.pid, what: 'lab 9 (run)', at: '2026-11-24T12:00:00.000Z' }));
      const taken = await takeLock(file, 'lab 9 (reset)');
      await taken();
      await expect(fs.access(file)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
