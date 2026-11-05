import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { K8sStorageConfig } from '../../src/shared/types/kubernetes';

const execMock = vi.fn();

class FakeConnection extends EventEmitter {
  close = vi.fn();
}

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromFile = vi.fn();
    loadFromDefault = vi.fn();
    loadFromOptions = vi.fn();
    getContexts = vi.fn(() => []);
    getClusters = vi.fn(() => []);
    getUsers = vi.fn(() => []);
  }
  class Exec {
    exec = execMock;
  }
  return { KubeConfig, Exec };
});

import { K8sPodStorageProvider, POD_WRITE_SCRIPT } from '../../src/main/storage/K8sPodStorageProvider';

const CONFIG: K8sStorageConfig = {
  id: 'k8s-ctx/ns/test-pod/app',
  name: 'test-pod (app)',
  contextName: 'ctx',
  namespace: 'ns',
  podName: 'test-pod',
  containerName: 'app',
  initialPath: '/',
};

describe('K8sPodStorageProvider', () => {
  let provider: K8sPodStorageProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new K8sPodStorageProvider(CONFIG);
  });

  it('initializes with correct properties', () => {
    expect(provider.id).toBe('k8s-ctx/ns/test-pod/app');
    expect(provider.name).toBe('test-pod (app)');
    expect(provider.type).toBe('k8s');
  });

  it('lists directory contents correctly', async () => {
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        const fakeOutput = [
          'app.js\t0\t1024 1727200000 644',
          'logs\t1\t4096 1727200000 755',
        ].join('\n');
        stdout.write(fakeOutput);
        stdout.end();
        statusCb({ status: 'Success' });
        return new FakeConnection();
      }
    );

    const entries = await provider.list('/var');
    expect(entries).toHaveLength(2);
    // Directories sorted first
    expect(entries[0].name).toBe('logs');
    expect(entries[0].isDirectory).toBe(true);
    expect(entries[0].path).toBe('/var/logs');
    expect(entries[0].permissions).toBe('755');

    expect(entries[1].name).toBe('app.js');
    expect(entries[1].isDirectory).toBe(false);
    expect(entries[1].path).toBe('/var/app.js');
    expect(entries[1].size).toBe(1024);
    expect(entries[1].permissions).toBe('644');
  });

  it('flags symlinks and special files so recursive transfers can skip them', async () => {
    execMock.mockImplementation(
      async (_ns: string, _pod: string, _c: string, _cmd: string[], stdout: PassThrough, _e: PassThrough, _i: any, _t: boolean, statusCb: any) => {
        stdout.write(
          [
            'file.txt\t0\t10 1727200000 644\t0\t1',
            'loop\t1\t4096 1727200000 777\t1\t0',
            'pipe\t0\t0 1727200000 644\t0\t0',
          ].join('\n')
        );
        stdout.end();
        statusCb({ status: 'Success' });
        return new FakeConnection();
      }
    );

    const byName = Object.fromEntries((await provider.list('/var')).map((e) => [e.name, e]));
    expect(byName['file.txt']).toMatchObject({ isSymlink: false, isSpecial: false });
    expect(byName['loop']).toMatchObject({ isDirectory: true, isSymlink: true });
    expect(byName['pipe']).toMatchObject({ isSymlink: false, isSpecial: true });
  });

  it('flags a FIFO as special and a symlink as a symlink in stat()', async () => {
    const run = async (line: string) => {
      execMock.mockImplementation(
        async (_ns: string, _pod: string, _c: string, _cmd: string[], stdout: PassThrough, _e: PassThrough, _i: any, _t: boolean, statusCb: any) => {
          stdout.write(line);
          stdout.end();
          statusCb({ status: 'Success' });
          return new FakeConnection();
        }
      );
      return provider.stat('/tmp/x');
    };
    expect(await run('0\t0 1727200000 644\t0\t0\n')).toMatchObject({ isSpecial: true, isSymlink: false });
    expect(await run('0\t5 1727200000 777\t1\t1\n')).toMatchObject({ isSpecial: false, isSymlink: true });
  });

  it('stats root directory without exec call', async () => {
    const entry = await provider.stat('/');
    expect(entry.name).toBe('/');
    expect(entry.isDirectory).toBe(true);
    expect(entry.path).toBe('/');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('stats specific file', async () => {
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        stdout.write('0\t2048 1727200000 600\n');
        stdout.end();
        statusCb({ status: 'Success' });
        return new FakeConnection();
      }
    );

    const entry = await provider.stat('/etc/config.json');
    expect(entry.name).toBe('config.json');
    expect(entry.path).toBe('/etc/config.json');
    expect(entry.size).toBe(2048);
    expect(entry.isDirectory).toBe(false);
    expect(entry.permissions).toBe('600');
  });

  it('creates folder', async () => {
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        expect(cmd).toEqual(['sh', '-c', 'mkdir -p -- "$1"', '--', '/data/newfolder']);
        statusCb({ status: 'Success' });
        return new FakeConnection();
      }
    );

    await provider.createFolder('/data/newfolder');
  });

  it('deletes file or directory', async () => {
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        expect(cmd).toEqual(['sh', '-c', 'rm -rf -- "$1"', '--', '/tmp/olddir']);
        statusCb({ status: 'Success' });
        return new FakeConnection();
      }
    );

    await provider.delete('/tmp/olddir', true);
  });

  it('refuses to delete container root directory', async () => {
    await expect(provider.delete('/', true)).rejects.toThrow('Refusing to delete container root directory');
  });

  it('renames file', async () => {
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        expect(cmd).toEqual(['sh', '-c', 'mv -- "$1" "$2"', '--', '/tmp/a.txt', '/tmp/b.txt']);
        statusCb({ status: 'Success' });
        return new FakeConnection();
      }
    );

    await provider.rename('/tmp/a.txt', '/tmp/b.txt');
  });

  it('chmods file', async () => {
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        expect(cmd).toEqual(['sh', '-c', 'chmod "$2" -- "$1"', '--', '/tmp/script.sh', '755']);
        statusCb({ status: 'Success' });
        return new FakeConnection();
      }
    );

    await provider.chmod('/tmp/script.sh', 0o755);
  });

  it('reads file content via readFile', async () => {
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        stdout: PassThrough,
        _stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        stdout.write(Buffer.from('hello from pod'));
        stdout.end();
        statusCb({ status: 'Success' });
        return new FakeConnection();
      }
    );

    const data = await provider.readFile('/etc/motd');
    expect(data.toString('utf-8')).toBe('hello from pod');
  });

  it('writes file content via writeFile', async () => {
    let capturedInput = '';
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        _stderr: PassThrough,
        stdin: Readable,
        _tty: boolean,
        statusCb: any
      ) => {
        stdin.on('data', (c) => {
          capturedInput += c.toString('utf-8');
        });
        stdin.on('end', () => {
          statusCb({ status: 'Success' });
        });
        return new FakeConnection();
      }
    );

    await provider.writeFile('/tmp/hello.txt', Buffer.from('new content'));
    expect(capturedInput).toBe('new content');
  });

  it('writeFile and createWriteStream both run the shared pod write script', async () => {
    const scripts: string[] = [];
    execMock.mockImplementation(
      async (_ns: string, _pod: string, _c: string, cmd: string[], _o: PassThrough, _e: PassThrough, stdin: Readable, _t: boolean, statusCb: any) => {
        scripts.push(cmd[2]);
        stdin.on('data', () => {});
        stdin.on('end', () => statusCb({ status: 'Success' }));
        return new FakeConnection();
      }
    );
    await provider.writeFile('/tmp/a.txt', Buffer.from('x'));
    const out = await provider.createWriteStream('/tmp/b.txt');
    await new Promise<void>((resolve, reject) => {
      out.once('finish', () => resolve());
      out.once('error', reject);
      out.end('x');
    });
    expect(scripts).toEqual([POD_WRITE_SCRIPT, POD_WRITE_SCRIPT]);
  });

  // The script runs in the pod's `sh`; run it for real so the exit status is what the pod would report.
  describe.skipIf(process.platform === 'win32')('POD_WRITE_SCRIPT exit status (real sh)', () => {
    const run = (script: string, target: string, mode: string) =>
      spawnSync('sh', ['-c', script, '--', target, mode], { input: 'data', encoding: 'utf-8' });
    const OLD_SCRIPT = `
mkdir -p "$(dirname "$1")" 2>/dev/null
cat > "$1"
if [ -n "$2" ]; then chmod "$2" "$1" 2>/dev/null; fi
`;

    it('fails when cat cannot write the file, with and without a mode', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podwrite-'));
      try {
        const blocked = path.join(dir, 'a-file-not-a-dir', 'x.txt');
        fs.writeFileSync(path.join(dir, 'a-file-not-a-dir'), '');
        expect(run(POD_WRITE_SCRIPT, blocked, '').status).not.toBe(0);
        expect(run(POD_WRITE_SCRIPT, blocked, '644').status).not.toBe(0);
        // Control: the previous script reported success for the same failed write.
        expect(run(OLD_SCRIPT, blocked, '').status).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('writes the file and applies the mode on success', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podwrite-'));
      try {
        const target = path.join(dir, 'sub', 'ok.txt');
        expect(run(POD_WRITE_SCRIPT, target, '600').status).toBe(0);
        expect(fs.readFileSync(target, 'utf-8')).toBe('data');
        expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('createWriteStream', () => {
    it('reports the target as touched once the exec has started, not when it could not start (H2)', async () => {
      execMock.mockImplementationOnce(async () => {
        throw new Error('exec refused');
      });
      const refused = (await provider.createWriteStream('/tmp/a.bin')) as NodeJS.WritableStream & { targetTouched: boolean };
      refused.on('error', () => {});
      expect(refused.targetTouched).toBe(false);

      execMock.mockImplementationOnce(async () => new FakeConnection());
      const started = (await provider.createWriteStream('/tmp/b.bin')) as NodeJS.WritableStream & { targetTouched: boolean };
      started.on('error', () => {});
      expect(started.targetTouched).toBe(true);
    });

    /** Wires exec so the test decides when (and how) the command in the pod finishes. */
    function podWithManualExit() {
      const conn = new FakeConnection();
      const pod: { statusCb?: (s: unknown) => void; stderr?: PassThrough; received: string } = { received: '' };
      execMock.mockImplementation(
        async (_ns: string, _p: string, _c: string, _cmd: string[], _out: PassThrough, stderr: PassThrough, stdin: Readable, _t: boolean, statusCb: any) => {
          pod.statusCb = statusCb;
          pod.stderr = stderr;
          stdin.on('data', (c) => {
            pod.received += c.toString('utf-8');
          });
          return conn;
        }
      );
      return { conn, pod };
    }
    const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

    it('does not finish before the command in the pod has exited', async () => {
      const { pod } = podWithManualExit();
      const out = await provider.createWriteStream('/tmp/big.bin');
      let finished = false;
      out.on('finish', () => {
        finished = true;
      });

      out.write(Buffer.from('payload'));
      out.end();
      await tick();
      // All the data is buffered and sent, but `cat` in the pod has not reported back yet.
      expect(pod.received).toBe('payload');
      expect(finished).toBe(false);

      pod.statusCb!({ status: 'Success' });
      await tick();
      expect(finished).toBe(true);
    });

    it('reports a write failure that only shows up after the data was sent', async () => {
      const { pod } = podWithManualExit();
      const out = await provider.createWriteStream('/tmp/full.bin');
      const outcome = new Promise<Error | null>((resolve) => {
        out.on('error', (err) => resolve(err));
        out.on('finish', () => resolve(null));
      });

      out.end(Buffer.from('payload'));
      await tick();
      pod.stderr!.write('cat: write error: No space left on device');
      pod.statusCb!({ status: 'Failure', message: 'command terminated' });

      const err = await outcome;
      expect(err?.message).toContain('No space left on device');
    });

    it('gives up when the pod never reports back after the last byte', async () => {
      podWithManualExit();
      const out = await provider.createWriteStream('/tmp/hung.bin');
      const outcome = new Promise<Error | null>((resolve) => {
        out.on('error', (err) => resolve(err));
        out.on('finish', () => resolve(null));
      });

      vi.useFakeTimers();
      try {
        out.end(Buffer.from('payload'));
        await vi.advanceTimersByTimeAsync(60_001);
      } finally {
        vi.useRealTimers();
      }

      expect((await outcome)?.message).toMatch(/Timed out waiting for the pod/);
    });

    it('closes the exec session when the write times out or is aborted, but not after a clean finish', async () => {
      // Timed out: the command may still be running in the pod.
      const hung = podWithManualExit();
      const timedOut = await provider.createWriteStream('/tmp/hung.bin');
      timedOut.on('error', () => {});
      vi.useFakeTimers();
      try {
        timedOut.end(Buffer.from('payload'));
        await vi.advanceTimersByTimeAsync(60_001);
      } finally {
        vi.useRealTimers();
      }
      expect(hung.conn.close).toHaveBeenCalledTimes(1);

      // Aborted by the caller (e.g. a cancelled transfer).
      const aborted = podWithManualExit();
      const cancelled = await provider.createWriteStream('/tmp/aborted.bin');
      cancelled.on('error', () => {});
      cancelled.write(Buffer.from('partial'));
      (cancelled as import('node:stream').Writable).destroy(new Error('cancelled'));
      await tick();
      expect(aborted.conn.close).toHaveBeenCalledTimes(1);

      // Finished cleanly: the command has already exited, nothing to end.
      const clean = podWithManualExit();
      const finished = await provider.createWriteStream('/tmp/clean.bin');
      finished.end(Buffer.from('payload'));
      await tick();
      clean.pod.statusCb!({ status: 'Success' });
      await tick();
      expect(clean.conn.close).not.toHaveBeenCalled();
    });

    it('closes the exec session when the stream is destroyed without an error', async () => {
      const { conn } = podWithManualExit();
      const out = await provider.createWriteStream('/tmp/cancelled.bin');
      out.write(Buffer.from('partial'));
      (out as import('node:stream').Writable).destroy(); // e.g. a cancelled upload
      await tick();
      expect(conn.close).toHaveBeenCalledTimes(1);
    });

    it('fails a write in progress when the connection drops, instead of leaving it waiting for buffer room', async () => {
      const { conn } = podWithManualExit();
      const out = await provider.createWriteStream('/tmp/dropped.bin');
      const outcome = new Promise<Error | null>((resolve) => {
        out.on('error', (err) => resolve(err));
        out.on('finish', () => resolve(null));
      });

      out.write(Buffer.from('partial')); // not ended: final() is never reached
      await tick();
      conn.emit('close');

      expect((await outcome)?.message).toMatch(/closed before the write finished/);
    });

    it('does not fail a finished write when its connection closes afterwards', async () => {
      const { conn, pod } = podWithManualExit();
      const out = await provider.createWriteStream('/tmp/done.bin');
      const errors: Error[] = [];
      out.on('error', (err) => errors.push(err));
      out.end(Buffer.from('payload'));
      await tick();
      pod.statusCb!({ status: 'Success' });
      await tick();
      conn.emit('close'); // the normal end of a websocket
      await tick();
      expect(errors).toEqual([]);
    });

    it('leaves no timer behind when a write is abandoned while it waits for the pod to finish', async () => {
      const { conn } = podWithManualExit();
      const out = await provider.createWriteStream('/tmp/abandoned.bin');
      out.on('error', () => {});

      vi.useFakeTimers();
      try {
        out.end(Buffer.from('payload')); // final() starts waiting, with its limit running
        await vi.advanceTimersByTimeAsync(5);
        (out as import('node:stream').Writable).destroy(new Error('cancelled'));
        await vi.advanceTimersByTimeAsync(5);
        conn.emit('close'); // closing the session produces this
        await vi.advanceTimersByTimeAsync(5);
        expect(vi.getTimerCount()).toBe(0);
        expect(conn.close).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not wait forever when the connection closes without a status', async () => {
      const { conn } = podWithManualExit();
      const out = await provider.createWriteStream('/tmp/x.bin');
      const outcome = new Promise<Error | null>((resolve) => {
        out.on('error', (err) => resolve(err));
        out.on('finish', () => resolve(null));
      });

      out.end(Buffer.from('payload'));
      await tick();
      conn.emit('close');

      expect((await outcome)?.message).toMatch(/closed before the write finished/);
    });
  });

  it('throws descriptive error on command failure', async () => {
    execMock.mockImplementation(
      async (
        _ns: string,
        _pod: string,
        _container: string,
        _cmd: string[],
        _stdout: PassThrough,
        stderr: PassThrough,
        _stdin: any,
        _tty: boolean,
        statusCb: any
      ) => {
        stderr.write('Permission denied\n');
        statusCb({
          status: 'Failure',
          message: 'command terminated with exit code 1',
          details: { causes: [{ reason: 'ExitCode', message: '1' }] },
        });
        return new FakeConnection();
      }
    );

    await expect(provider.readFile('/root/secret')).rejects.toThrow('Permission denied');
  });
});
