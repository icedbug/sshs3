import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The worker loads pkcs11js, a native module. Where it was not built (an install without a compiler),
// the worker cannot be loaded at all and the suite is skipped; any other failure to load is a real one.
let worker: { runCertWorker: any; readCertificatesFromSlot: any } | undefined;
try {
  worker = require('../../src/main/smartcard/certWorker.cjs');
} catch (error) {
  if (!/pkcs11\.node|pkcs11js/.test(String((error as Error)?.message))) throw error;
}
const { runCertWorker, readCertificatesFromSlot } = worker ?? ({} as { runCertWorker: any; readCertificatesFromSlot: any });

describe.skipIf(!worker)('certWorker.cjs', () => {
  it('outputs error JSON when pkcs11LibPath argument is missing', async () => {
    let output = '';
    const mockStdout = {
      write: (data: string) => {
        output += data;
        return true;
      },
    };

    await runCertWorker([], mockStdout as any);
    const parsed = JSON.parse(output.trim());
    expect(parsed).toEqual({ error: 'missing pkcs11LibPath argument' });
  });

  it('outputs error JSON when pkcs11.load fails', async () => {
    let output = '';
    const mockStdout = {
      write: (data: string) => {
        output += data;
        return true;
      },
    };

    class FailingPkcs11 {
      load() {
        throw new Error('libpkcs11.so: cannot open shared object');
      }
      C_Initialize() {}
    }

    await runCertWorker(['/opt/lib/libpkcs11.so'], mockStdout as any, FailingPkcs11 as any);
    const parsed = JSON.parse(output.trim());
    expect(parsed.error).toContain('cannot open shared object');
  });

  it('outputs error JSON when C_GetSlotList fails', async () => {
    let output = '';
    const mockStdout = {
      write: (data: string) => {
        output += data;
        return true;
      },
    };

    class FailingSlotPkcs11 {
      load() {}
      C_Initialize() {}
      C_GetSlotList() {
        throw new Error('CKR_DEVICE_ERROR');
      }
    }

    await runCertWorker(['/opt/lib/libpkcs11.so'], mockStdout as any, FailingSlotPkcs11 as any);
    const parsed = JSON.parse(output.trim());
    expect(parsed).toEqual({ error: 'CKR_DEVICE_ERROR' });
  });

  it('extracts X.509 certificates from slots and encodes as base64 DER', async () => {
    let output = '';
    const mockStdout = {
      write: (data: string) => {
        output += data;
        return true;
      },
    };

    const derCert1 = Buffer.from([0x30, 0x82, 0x01, 0x0a]);
    const derCert2 = Buffer.from([0x30, 0x82, 0x02, 0x14]);

    class SuccessfulPkcs11 {
      load = vi.fn();
      C_Initialize = vi.fn();
      C_GetSlotList = vi.fn().mockReturnValue([Buffer.from([1]), Buffer.from([2])]);
      C_OpenSession = vi.fn().mockReturnValue(100);
      C_FindObjectsInit = vi.fn();
      C_FindObjects = vi.fn().mockImplementation((_session: number) => {
        return [Buffer.from([0x01]), Buffer.from([0x02])];
      });
      C_FindObjectsFinal = vi.fn();
      C_GetAttributeValue = vi.fn().mockImplementation((_session: number, obj: Buffer) => {
        if (obj[0] === 0x01) {
          return [{ type: 0x11, value: derCert1 }];
        }
        return [{ type: 0x11, value: derCert2 }];
      });
      C_CloseSession = vi.fn();
      C_Finalize = vi.fn().mockImplementation(() => {
        throw new Error('Simulated vendor C_Finalize SIGTRAP / crash');
      });
    }

    await runCertWorker(['/usr/lib/libiidp11.so'], mockStdout as any, SuccessfulPkcs11 as any);
    const parsed = JSON.parse(output.trim());
    expect(parsed.certs).toHaveLength(4); // 2 slots * 2 certs
    expect(parsed.certs[0]).toBe(derCert1.toString('base64'));
    expect(parsed.certs[1]).toBe(derCert2.toString('base64'));
  });

  it('handles unreadable attributes and slot retry gracefully in readCertificatesFromSlot', () => {
    const derList: string[] = [];
    const mockPkcs11 = {
      C_OpenSession: vi.fn().mockReturnValue(50),
      C_FindObjectsInit: vi.fn(),
      C_FindObjects: vi.fn().mockReturnValue([Buffer.from([0x01]), Buffer.from([0x02])]),
      C_FindObjectsFinal: vi.fn(),
      C_GetAttributeValue: vi.fn().mockImplementation((_s: number, obj: Buffer) => {
        if (obj[0] === 0x01) {
          throw new Error('CKR_ATTRIBUTE_SENSITIVE');
        }
        return [{ value: null }];
      }),
      C_CloseSession: vi.fn(),
    };

    const res = readCertificatesFromSlot(mockPkcs11, Buffer.from([1]), derList);
    expect(res.attempted).toBe(true);
    expect(res.objectCount).toBe(2);
    expect(derList).toHaveLength(0); // None added due to error/null
  });

  it('handles slot opening failure and records error', () => {
    const derList: string[] = [];
    const mockPkcs11 = {
      C_OpenSession: vi.fn().mockImplementation(() => {
        throw new Error('CKR_TOKEN_NOT_PRESENT');
      }),
      C_CloseSession: vi.fn(),
    };

    const res = readCertificatesFromSlot(mockPkcs11, Buffer.from([1]), derList);
    expect(res.attempted).toBe(true);
    expect(res.objectCount).toBe(0);
    expect(res.error).toBeDefined();
  });
});
