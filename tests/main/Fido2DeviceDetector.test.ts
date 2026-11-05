import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isFido2DeviceConnected, isFidoReportDescriptor } from '../../src/main/smartcard/Fido2DeviceDetector';

const FIDO = Buffer.from([0x06, 0xd0, 0xf1, 0x09, 0x01, 0xa1, 0x01]);
const MOUSE = Buffer.from([0x05, 0x01, 0x09, 0x02, 0xa1, 0x01]);

describe('Fido2DeviceDetector', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function setup(descriptors: Record<string, Buffer>): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidraw-'));
    for (const [name, data] of Object.entries(descriptors)) {
      fs.mkdirSync(path.join(dir, name, 'device'), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'device', 'report_descriptor'), data);
    }
    return dir;
  }

  it('recognizes the FIDO usage page', () => {
    expect(isFidoReportDescriptor(FIDO)).toBe(true);
    expect(isFidoReportDescriptor(MOUSE)).toBe(false);
  });

  it('is true when a hidraw node is a FIDO device', async () => {
    expect(await isFido2DeviceConnected(setup({ hidraw0: MOUSE, hidraw1: FIDO }))).toBe(true);
  });

  it('is false when no node is a FIDO device', async () => {
    expect(await isFido2DeviceConnected(setup({ hidraw0: MOUSE }))).toBe(false);
  });

  it('is undefined when the directory cannot be read', async () => {
    expect(await isFido2DeviceConnected(path.join(os.tmpdir(), 'does-not-exist-hidraw'))).toBeUndefined();
  });
});
