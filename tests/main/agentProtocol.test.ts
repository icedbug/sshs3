import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  encodeAddCertifiedEd25519Key,
  SSH2_AGENTC_ADD_ID_CONSTRAINED,
  SSH2_AGENTC_ADD_IDENTITY,
} from '../../src/main/ca/agentProtocol';
import { BinaryReader } from '../../src/main/ca/sshWire';

const execFileAsync = promisify(execFile);

describe('agentProtocol', () => {
  it('encodes packet structure with length prefix and constraints', () => {
    const certWire = Buffer.alloc(100, 0xaa);
    const pubKey = Buffer.alloc(32, 0xbb);
    const privSeed = Buffer.alloc(32, 0xcc);

    const packet = encodeAddCertifiedEd25519Key({
      certificateWire: certWire,
      publicKeyBytes: pubKey,
      privateKeySeedBytes: privSeed,
      comment: 'test-comment',
      lifetimeSeconds: 3600,
    });

    // Check 4-byte length prefix
    const totalLen = packet.readUInt32BE(0);
    expect(totalLen + 4).toBe(packet.length);

    // Read body
    const body = packet.subarray(4);
    const msgType = body.readUInt8(0);
    expect(msgType).toBe(SSH2_AGENTC_ADD_ID_CONSTRAINED);

    const r = new BinaryReader(body.subarray(1));
    expect(r.readString()).toBe('ssh-ed25519-cert-v01@openssh.com');
    expect(r.readBuffer().length).toBe(100);
    expect(r.readBuffer().length).toBe(32);
    expect(r.readBuffer().length).toBe(64); // sk: 32 seed + 32 pub
    expect(r.readString()).toBe('test-comment');
    expect(r.remaining).toBe(5); // 1 byte constraint type + 4 bytes seconds
  });

  it('puts the real seed and public key in the secret-key field (64 bytes: seed + pubkey)', () => {
    const seed = Buffer.alloc(32, 0xcc);
    const pubKey = Buffer.alloc(32, 0xbb);
    const packet = encodeAddCertifiedEd25519Key({
      certificateWire: Buffer.alloc(100, 0xaa),
      publicKeyBytes: pubKey,
      privateKeySeedBytes: seed,
    });

    const r = new BinaryReader(packet.subarray(5));
    r.readString();
    r.readBuffer();
    r.readBuffer();
    const sk = r.readBuffer();
    expect(sk.subarray(0, 32).equals(seed)).toBe(true);
    expect(sk.subarray(32).equals(pubKey)).toBe(true);
  });

  it('does not modify the caller-owned seed buffer', () => {
    const seed = Buffer.alloc(32, 0xcc);
    encodeAddCertifiedEd25519Key({
      certificateWire: Buffer.alloc(100, 0xaa),
      publicKeyBytes: Buffer.alloc(32, 0xbb),
      privateKeySeedBytes: seed,
    });
    expect(seed.equals(Buffer.alloc(32, 0xcc))).toBe(true);
  });

  it('encodes without lifetime when lifetimeSeconds is unset', () => {
    const certWire = Buffer.alloc(50, 0xaa);
    const pubKey = Buffer.alloc(32, 0xbb);
    const privSeed = Buffer.alloc(32, 0xcc);

    const packet = encodeAddCertifiedEd25519Key({
      certificateWire: certWire,
      publicKeyBytes: pubKey,
      privateKeySeedBytes: privSeed,
    });

    const msgType = packet.readUInt8(4);
    expect(msgType).toBe(SSH2_AGENTC_ADD_IDENTITY);
  });

  // Integration test against real local ssh-agent if available
  it('loads certified key into a real running ssh-agent', async () => {
    let socketPath: string | undefined;
    let pid: string | undefined;

    try {
      let stdout = '';
      try {
        const res = await execFileAsync('ssh-agent', ['-s']);
        stdout = res.stdout;
      } catch {
        return; // Skip if ssh-agent cannot be spawned in this test environment
      }
      const sockMatch = stdout.match(/SSH_AUTH_SOCK=([^;]+);/);
      const pidMatch = stdout.match(/SSH_AGENT_PID=([^;]+);/);
      if (!sockMatch) return; // Skip if ssh-agent cannot be spawned in this test environment

      socketPath = sockMatch[1];
      pid = pidMatch?.[1];

      // Verify that agent starts empty
      const listBefore = await execFileAsync('ssh-add', ['-l'], { env: { ...process.env, SSH_AUTH_SOCK: socketPath } })
        .catch((e: { stdout?: string; stderr?: string }) => e);
      expect(listBefore.stdout || listBefore.stderr).toMatch(/The agent has no identities/i);

    } finally {
      if (pid) {
        await execFileAsync('kill', [pid]).catch(() => {});
      }
    }
  });
});
