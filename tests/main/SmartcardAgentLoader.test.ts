import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  execWithPresenceDetection,
  pinPromptKind,
  isTextlessExitFailure,
  loadFido2ResidentKeysIntoPrivateAgent,
} from '../../src/main/smartcard/SmartcardAgentLoader';
import { AgentLifecycleManager } from '../../src/main/ssh/AgentLifecycleManager';
import { AskpassServer } from '../../src/main/smartcard/AskpassServer';

/**
 * These drive execWithPresenceDetection against a real short-lived `node -e`
 * child process rather than mocking child_process, since the behavior under
 * test IS the streaming-output detection (a mocked spawn wouldn't emit data
 * events the same way a real process does).
 */
describe('execWithPresenceDetection', () => {
  it('resolves without calling onPresenceRequested when the process prints nothing notable', async () => {
    let called = false;
    await execWithPresenceDetection(
      process.execPath,
      ['-e', 'console.log("all good")'],
      { env: process.env, timeoutMs: 5000 },
      () => {
        called = true;
      }
    );
    expect(called).toBe(false);
  });

  it('calls onPresenceRequested when stderr contains a known touch-prompt hint', async () => {
    let called = false;
    await execWithPresenceDetection(
      process.execPath,
      ['-e', 'console.error("Confirm user presence for key ED25519-SK SHA256:abc"); '],
      { env: process.env, timeoutMs: 5000 },
      () => {
        called = true;
      }
    );
    expect(called).toBe(true);
  });

  it('calls onPresenceRequested at most once even if the hint is printed repeatedly', async () => {
    let callCount = 0;
    await execWithPresenceDetection(
      process.execPath,
      ['-e', 'console.error("please touch your security key"); console.error("please touch your security key");'],
      { env: process.env, timeoutMs: 5000 },
      () => {
        callCount += 1;
      }
    );
    expect(callCount).toBe(1);
  });

  it('rejects when the process exits with a non-zero code', async () => {
    await expect(
      execWithPresenceDetection(process.execPath, ['-e', 'process.exit(1)'], { env: process.env, timeoutMs: 5000 })
    ).rejects.toThrow();
  });

  it('includes the process\'s own output in the rejection so failures are diagnosable', async () => {
    await expect(
      execWithPresenceDetection(
        process.execPath,
        ['-e', 'console.error("no FIDO authenticator found"); process.exit(1)'],
        { env: process.env, timeoutMs: 5000 }
      )
    ).rejects.toThrow(/no FIDO authenticator found/);
  });

  it('closes stdin so a child waiting on an interactive y/n prompt fails fast instead of hanging', async () => {
    // Mirrors ssh-keygen's real "Overwrite key in token (y/n)?" prompt: reads a line from stdin,
    // and if it never arrives (EOF), exits non-zero instead of blocking forever.
    const start = Date.now();
    await expect(
      execWithPresenceDetection(
        process.execPath,
        [
          '-e',
          'process.stdout.write("Overwrite? (y/n) "); ' +
            'process.stdin.on("data", () => {}); ' +
            'process.stdin.on("end", () => { console.error("no answer given"); process.exit(1); });',
        ],
        { env: process.env, timeoutMs: 5000 }
      )
    ).rejects.toThrow(/no answer given/);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('isTextlessExitFailure', () => {
  it('is true for a bare "exited with code N" message', () => {
    expect(isTextlessExitFailure(new Error('ssh-add -K exited with code 1'))).toBe(true);
  });

  it('is false once any detail is appended', () => {
    expect(
      isTextlessExitFailure(new Error('ssh-add -K exited with code 1: incorrect passphrase supplied'))
    ).toBe(false);
  });

  it('is false for a non-Error value', () => {
    expect(isTextlessExitFailure('not an error')).toBe(false);
  });
});

/**
 * End-to-end against a real spawnPrivateAgent() (a real `ssh-agent -s`) but with a fake `ssh-add`
 * script placed first on PATH, so the fix for OpenSSH's "-K with nothing on the device" quirk is
 * verified against the actual retry loop rather than just the isolated predicate above.
 */
describe.skipIf(process.platform === 'win32')('loadFido2ResidentKeysIntoPrivateAgent — "no resident credentials yet" quirk', () => {
  const originalPath = process.env.PATH;
  let fakeBinDir: string | undefined;

  afterEach(async () => {
    process.env.PATH = originalPath;
    if (fakeBinDir) {
      await fs.rm(fakeBinDir, { recursive: true, force: true });
      fakeBinDir = undefined;
    }
  });

  /**
   * Mirrors the connection logic the generated askpass script actually
   * uses: a Unix domain socket on POSIX (AskpassServer.getSocketPath()),
   * falling back to the TCP loopback port on Windows, which has no
   * equivalent mode-restricted socket file.
   */
  function connectToAskpass(server: { getPort(): number; getSocketPath(): string | null }): net.Socket {
    const socketPath = server.getSocketPath();
    return socketPath ? net.createConnection({ path: socketPath }) : net.createConnection({ port: server.getPort(), host: '127.0.0.1' });
  }

  async function installFakeSshAdd(script: string): Promise<void> {
    fakeBinDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-ssh-add-'));
    const scriptPath = path.join(fakeBinDir, 'ssh-add');
    await fs.writeFile(scriptPath, script, { mode: 0o755 });
    await fs.chmod(scriptPath, 0o755);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
  }

  it('resolves with zero identities instead of throwing when -K fails with no output at all', async () => {
    await installFakeSshAdd(
      '#!/bin/sh\n' +
        'if [ "$1" = "-K" ]; then exit 1; fi\n' +
        'if [ "$1" = "-l" ]; then echo "The agent has no identities."; exit 1; fi\n' +
        'exit 0\n'
    );

    const { pid, socketPath } = await loadFido2ResidentKeysIntoPrivateAgent(() => '1234');
    expect(socketPath).toBeTruthy();
    AgentLifecycleManager.killPrivateAgent(pid);
  });

  it('still throws when -K fails WITH descriptive output (a real error, not the quirk)', async () => {
    await installFakeSshAdd(
      '#!/bin/sh\n' +
        'if [ "$1" = "-K" ]; then echo "incorrect passphrase supplied to decrypt private key" 1>&2; exit 1; fi\n' +
        'if [ "$1" = "-l" ]; then echo "The agent has no identities."; exit 1; fi\n' +
        'exit 0\n'
    );

    await expect(loadFido2ResidentKeysIntoPrivateAgent(() => '', { retries: 0 })).rejects.toThrow(
      /incorrect passphrase/
    );
  });

  it('with keepAskpassAliveForAgentLifetime, wires its own Askpass env into the spawned agent process and leaves it running', async () => {
    await installFakeSshAdd('#!/bin/sh\nif [ "$1" = "-K" ]; then exit 0; fi\nif [ "$1" = "-l" ]; then echo "no output"; exit 0; fi\nexit 0\n');

    const spawnSpy = vi.spyOn(AgentLifecycleManager, 'spawnPrivateAgent');
    const { pid, socketPath, askpassServer } = await loadFido2ResidentKeysIntoPrivateAgent(() => '1234', {
      keepAskpassAliveForAgentLifetime: true,
    });

    try {
      expect(askpassServer).toBeDefined();
      expect(askpassServer!.isRunning()).toBe(true);

      // spawnPrivateAgent must have been given THIS SAME askpass server's env (its script path is
      // unique per instance), not just called with nothing — otherwise the agent process falls
      // back to whatever SSH_ASKPASS this app inherited (e.g. the desktop's own ksshaskpass).
      const passedEnv = spawnSpy.mock.calls[0]?.[0] as Record<string, string> | undefined;
      expect(passedEnv?.SSH_ASKPASS).toBe(askpassServer!.getScriptPath());
    } finally {
      await askpassServer?.stop();
      AgentLifecycleManager.killPrivateAgent(pid);
      spawnSpy.mockRestore();
    }
    expect(socketPath).toBeTruthy();
  });

  // Low finding: the askpass server was started before the try block, so a failure to spawn the agent left it running.
  for (const keepAlive of [false, true]) {
    it(`stops its Askpass server when the private agent cannot be started (keepAskpassAliveForAgentLifetime=${keepAlive})`, async () => {
      await installFakeSshAdd('#!/bin/sh\nexit 0\n');
      const spawn = vi.spyOn(AgentLifecycleManager, 'spawnPrivateAgent').mockRejectedValue(new Error('no agent for you'));
      const stop = vi.spyOn(AskpassServer.prototype, 'stop');
      try {
        await expect(
          loadFido2ResidentKeysIntoPrivateAgent(() => '1234', { keepAskpassAliveForAgentLifetime: keepAlive })
        ).rejects.toThrow('no agent for you');
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        spawn.mockRestore();
        stop.mockRestore();
      }
    });
  }

  it('without keepAskpassAliveForAgentLifetime, stops its Askpass server once the load finishes', async () => {
    await installFakeSshAdd('#!/bin/sh\nif [ "$1" = "-K" ]; then exit 0; fi\nif [ "$1" = "-l" ]; then echo "no output"; exit 0; fi\nexit 0\n');

    const { pid, socketPath, askpassServer } = await loadFido2ResidentKeysIntoPrivateAgent(() => '1234');

    expect(socketPath).toBeTruthy();
    expect(askpassServer).toBeUndefined();
    AgentLifecycleManager.killPrivateAgent(pid);
  });

  // Low finding: the replay had no guard, so a PIN that had become wrong (changed on the key) was replayed for
  // every signature and burnt the authenticator's retries. Same rule as AppAgent's FIDO2 PIN.
  it('with keepAskpassAliveForAgentLifetime, asks the user again instead of replaying a PIN that is requested again right away', async () => {
    await installFakeSshAdd('#!/bin/sh\nif [ "$1" = "-K" ]; then exit 0; fi\nif [ "$1" = "-l" ]; then echo "no output"; exit 0; fi\nexit 0\n');
    const promptHandler = vi.fn().mockResolvedValueOnce('first-pin').mockResolvedValue('typed-after-failure');

    const { pid, askpassServer } = await loadFido2ResidentKeysIntoPrivateAgent(promptHandler, { keepAskpassAliveForAgentLifetime: true });
    try {
      const ask = (prompt: string) =>
        new Promise<{ pin: string }>((resolve) => {
          const client = connectToAskpass(askpassServer!);
          client.on('connect', () => client.write(JSON.stringify({ token: (askpassServer as any).token, prompt }) + '\n'));
          client.on('data', (d) => {
            resolve(JSON.parse(d.toString().trim()));
            client.end();
          });
        });
      const sigPrompt = 'Enter PIN and confirm user presence for ED25519-SK key SHA256:abc: ';

      expect(await ask(sigPrompt)).toEqual({ pin: 'first-pin' }); // nothing cached yet: the user is asked
      expect(await ask(sigPrompt)).toEqual({ pin: 'first-pin' }); // replayed
      expect(promptHandler).toHaveBeenCalledTimes(1);

      expect(await ask(sigPrompt)).toEqual({ pin: 'typed-after-failure' }); // asked again at once: it was wrong
      expect(promptHandler).toHaveBeenCalledTimes(2);
    } finally {
      await askpassServer?.stop();
      AgentLifecycleManager.killPrivateAgent(pid);
    }
  });

  it('with keepAskpassAliveForAgentLifetime, reuses the cached PIN for subsequent signature prompts without calling promptHandler again', async () => {
    await installFakeSshAdd('#!/bin/sh\nif [ "$1" = "-K" ]; then exit 0; fi\nif [ "$1" = "-l" ]; then echo "no output"; exit 0; fi\nexit 0\n');

    const promptHandler = vi.fn().mockResolvedValue('cached-pin-999');
    const onPresenceRequested = vi.fn();

    const { pid, socketPath, askpassServer } = await loadFido2ResidentKeysIntoPrivateAgent(promptHandler, {
      keepAskpassAliveForAgentLifetime: true,
      onPresenceRequested,
    });

    try {
      expect(socketPath).toBeTruthy();
      // 1. Initial load prompt (from ssh-add)
      const client1 = connectToAskpass(askpassServer!);
      const pinResponse1 = await new Promise((resolve) => {
        client1.on('connect', () => {
          client1.write(
            JSON.stringify({
              token: (askpassServer as any).token,
              prompt: 'Enter PIN for authenticator: ',
            }) + '\n'
          );
        });
        client1.on('data', (d) => {
          resolve(JSON.parse(d.toString().trim()));
          client1.end();
        });
      });
      expect(pinResponse1).toEqual({ pin: 'cached-pin-999' });
      expect(promptHandler).toHaveBeenCalledTimes(1);

      // 2. Now simulate ssh-agent issuing a subsequent signature PIN prompt
      const client2 = connectToAskpass(askpassServer!);
      const pinResponse2 = await new Promise((resolve) => {
        client2.on('connect', () => {
          client2.write(
            JSON.stringify({
              token: (askpassServer as any).token,
              prompt: 'Enter PIN and confirm user presence: ',
            }) + '\n'
          );
        });
        client2.on('data', (d) => {
          resolve(JSON.parse(d.toString().trim()));
          client2.end();
        });
      });

      expect(pinResponse2).toEqual({ pin: 'cached-pin-999' });
      // promptHandler was NOT called a second time because the PIN was reused from cache
      expect(promptHandler).toHaveBeenCalledTimes(1);
      // onPresenceRequested was called because the prompt asked to confirm user presence
      expect(onPresenceRequested).toHaveBeenCalledTimes(1);

      // Simulate a pure presence notification (notify_start from ssh-agent)
      const presenceClient = connectToAskpass(askpassServer!);
      const presenceResponse = await new Promise((resolve) => {
        presenceClient.on('connect', () => {
          presenceClient.write(
            JSON.stringify({
              token: (askpassServer as any).token,
              prompt: 'Confirm user presence for key ED25519-SK SHA256:abc',
              promptType: 'none',
            }) + '\n'
          );
        });
        presenceClient.on('data', (d) => {
          resolve(JSON.parse(d.toString().trim()));
          presenceClient.end();
        });
      });

      expect(presenceResponse).toEqual({ pin: '' });
      expect(onPresenceRequested).toHaveBeenCalledTimes(2);
      expect(promptHandler).toHaveBeenCalledTimes(1);
    } finally {
      await askpassServer?.stop();
      AgentLifecycleManager.killPrivateAgent(pid);
    }
  });
});

describe('pinPromptKind', () => {
  it('recognises FIDO2 prompts, including the per-signature one for a verify-required key', () => {
    expect(pinPromptKind('Enter PIN and confirm user presence for ED25519-SK key SHA256:abc: ')).toBe('fido2');
    expect(pinPromptKind('Enter PIN for authenticator: ')).toBe('fido2');
    expect(pinPromptKind('Confirm user presence for key ECDSA-SK SHA256:abc')).toBe('fido2');
  });

  it('treats everything else as a smartcard prompt', () => {
    expect(pinPromptKind('Enter passphrase for PKCS#11: ')).toBe('smartcard');
    expect(pinPromptKind('Enter PIN for PIV_II (PIV Card Holder pin): ')).toBe('smartcard');
  });
});
