import { describe, it, expect } from 'vitest';
import {
  CURRENT_FORMAT_VERSION,
  FORMAT_MIGRATIONS,
  migrateToCurrentFormat,
  serializePayload,
  unknownPayloadKeys,
} from '../../src/main/services/teamVaultFormat';
import type { TeamVaultFile, TeamVaultPayload } from '../../src/shared/types/teamVault';

const key = Buffer.alloc(32, 7);
const fakeCrypto = {
  decryptPayload: (_k: Buffer, _id: string, v: number, p: string) => `plain(${v}):${p}`,
  encryptPayload: (_k: Buffer, _id: string, v: number, plain: string) => `enc(${v}):${plain}`,
} as never;
const v1 = { formatVersion: 1, vaultId: 'v', revision: 4, encryptedPayload: 'P' } as unknown as TeamVaultFile;

describe('migrateToCurrentFormat', () => {
  it('re-encrypts a v1 payload for the current format and leaves revision alone', () => {
    const out = migrateToCurrentFormat(v1, key, false, fakeCrypto)!;
    expect(out.formatVersion).toBe(CURRENT_FORMAT_VERSION);
    expect(out.revision).toBe(4);
    expect(out.encryptedPayload).toBe('enc(2):plain(1):P');
  });

  it('returns the file untouched when it is already current', () => {
    const current = { ...v1, formatVersion: CURRENT_FORMAT_VERSION } as TeamVaultFile;
    expect(migrateToCurrentFormat(current, key, false, fakeCrypto)).toBe(current);
  });

  it('refuses a step that needs an admin when the session is not one, and a step that does not exist', () => {
    const original = FORMAT_MIGRATIONS[1];
    try {
      FORMAT_MIGRATIONS[1] = { ...original, requires: 'admin' };
      expect(migrateToCurrentFormat(v1, key, false, fakeCrypto)).toBeNull();
      expect(migrateToCurrentFormat(v1, key, true, fakeCrypto)).not.toBeNull();
    } finally {
      FORMAT_MIGRATIONS[1] = original;
    }
    expect(migrateToCurrentFormat({ ...v1, formatVersion: 0 } as unknown as TeamVaultFile, key, true, fakeCrypto)).toBeNull();
  });
});

describe('payload keys', () => {
  it('finds only keys this version does not know', () => {
    expect(unknownPayloadKeys({ ssh: [], s3: [], future: 1 })).toEqual({ future: 1 });
    expect(unknownPayloadKeys({ ssh: [], unknownKeys: { x: 1 } })).toBeUndefined();
    expect(unknownPayloadKeys('nope')).toBeUndefined();
  });

  it('writes unknown keys back, lets known fields win, and never writes "unknownKeys" itself', () => {
    const payload = { ssh: [], s3: [], folders: [], folderIcons: {}, k8s: [], unknownKeys: { future: 1, ssh: 'ignored' } } as unknown as TeamVaultPayload;
    const json = JSON.parse(serializePayload(payload));
    expect(json.future).toBe(1);
    expect(json.ssh).toEqual([]);
    expect(json).not.toHaveProperty('unknownKeys');
  });
});
