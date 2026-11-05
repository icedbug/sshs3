import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isYkmanAvailable,
  listYkmanFidoCredentials,
  deleteYkmanFidoCredential,
  parseCsvLine,
} from '../../src/main/smartcard/YkmanFido';

describe('parseCsvLine', () => {
  it('splits a simple comma-separated line', () => {
    expect(parseCsvLine('abc123,ssh:id_ed25519_sk,alun,Alun')).toEqual([
      'abc123',
      'ssh:id_ed25519_sk',
      'alun',
      'Alun',
    ]);
  });

  it('handles a quoted field containing a comma', () => {
    expect(parseCsvLine('abc123,ssh:work,alun,"Doe, Jane"')).toEqual(['abc123', 'ssh:work', 'alun', 'Doe, Jane']);
  });

  it('handles an escaped quote inside a quoted field', () => {
    expect(parseCsvLine('abc123,ssh:work,alun,"Say ""hi"""')).toEqual(['abc123', 'ssh:work', 'alun', 'Say "hi"']);
  });

  it('handles empty fields', () => {
    expect(parseCsvLine('abc123,ssh:work,,')).toEqual(['abc123', 'ssh:work', '', '']);
  });
});

describe.skipIf(process.platform === 'win32')('isYkmanAvailable', () => {
  const originalPath = process.env.PATH;
  let fakeBinDir: string | undefined;

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (fakeBinDir) {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      fakeBinDir = undefined;
    }
  });

  it('is false when ykman is not on PATH', async () => {
    fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'no-ykman-'));
    process.env.PATH = fakeBinDir; // an empty dir, deliberately excluding the real PATH
    expect(await isYkmanAvailable()).toBe(false);
  });

  it('is true when a working ykman is on PATH', async () => {
    fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ykman-'));
    await fs.writeFile(path.join(fakeBinDir, 'ykman'), '#!/bin/sh\necho "1.2.3"\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
    expect(await isYkmanAvailable()).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('listYkmanFidoCredentials / deleteYkmanFidoCredential', () => {
  const originalPath = process.env.PATH;
  let fakeBinDir: string | undefined;

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (fakeBinDir) {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      fakeBinDir = undefined;
    }
  });

  async function installFakeYkman(script: string): Promise<string> {
    fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ykman-'));
    const scriptPath = path.join(fakeBinDir, 'ykman');
    await fs.writeFile(scriptPath, script, { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
    return fakeBinDir;
  }

  it('feeds the PIN over stdin rather than as an argv value', async () => {
    fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ykman-'));
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
    const pinFile = path.join(fakeBinDir, 'captured-pin.txt');
    await fs.writeFile(
      path.join(fakeBinDir, 'ykman'),
      '#!/bin/sh\n' +
        'read pin\n' +
        `echo "$pin" > "${pinFile}"\n` +
        'echo "credential_id,rp_id,user_name,user_display_name,user_id"\n' +
        'exit 0\n',
      { mode: 0o755 }
    );

    await listYkmanFidoCredentials('123456');
    const capturedPin = (await fs.readFile(pinFile, 'utf-8')).trim();
    expect(capturedPin).toBe('123456');
  });

  it('parses the CSV output into structured credentials', async () => {
    await installFakeYkman(
      '#!/bin/sh\n' +
        'cat > /dev/null\n' + // consume stdin PIN
        'echo "credential_id,rp_id,user_name,user_display_name,user_id"\n' +
        'echo "abc123,ssh:id_ed25519_sk,alun,Alun Lundqvist,def456"\n' +
        'exit 0\n'
    );

    const creds = await listYkmanFidoCredentials('123456');
    expect(creds).toEqual([
      { credentialId: 'abc123', rpId: 'ssh:id_ed25519_sk', userName: 'alun', userDisplayName: 'Alun Lundqvist' },
    ]);
  });

  it('returns an empty list when there are no credentials', async () => {
    await installFakeYkman(
      '#!/bin/sh\ncat > /dev/null\necho "credential_id,rp_id,user_name,user_display_name,user_id"\nexit 0\n'
    );
    expect(await listYkmanFidoCredentials('123456')).toEqual([]);
  });

  it('rejects with ykman\'s own error text on a non-zero exit', async () => {
    await installFakeYkman('#!/bin/sh\ncat > /dev/null\necho "Wrong PIN attempts remaining: 2" 1>&2\nexit 1\n');
    await expect(listYkmanFidoCredentials('000000')).rejects.toThrow(/Wrong PIN/);
  });

  it('rejects cleanly, without an unhandled EPIPE, when ykman exits before reading the PIN', async () => {
    await installFakeYkman('#!/bin/sh\necho "No YubiKey found" 1>&2\nexit 1\n');
    // Large enough that the write cannot all sit in the pipe buffer of a process that is already gone.
    await expect(listYkmanFidoCredentials('1'.repeat(1_000_000))).rejects.toThrow(/No YubiKey found|exited with code 1/);
  });

  it('deletes a credential by id with --force, feeding the PIN over stdin', async () => {
    const dir = await installFakeYkman('#!/bin/sh\ncat > /dev/null\nexit 0\n');
    const argsFile = path.join(dir, 'captured-args.txt');
    await fs.writeFile(
      path.join(dir, 'ykman'),
      `#!/bin/sh\necho "$@" > "${argsFile}"\ncat > /dev/null\nexit 0\n`,
      { mode: 0o755 }
    );

    await deleteYkmanFidoCredential('abc123', '123456');
    const capturedArgs = await fs.readFile(argsFile, 'utf-8');
    expect(capturedArgs).toContain('fido credentials delete abc123 --force');
  });
});
