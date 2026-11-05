import fs from 'node:fs';
import path from 'node:path';

const HIDRAW_DIR = '/sys/class/hidraw';

/** HID report descriptor item `Usage Page (0xF1D0)`: the FIDO Alliance page every CTAP2 authenticator declares. */
const FIDO_USAGE_PAGE_ITEM = Buffer.from([0x06, 0xd0, 0xf1]);

export function isFidoReportDescriptor(descriptor: Buffer): boolean {
  return descriptor.includes(FIDO_USAGE_PAGE_ITEM);
}

/**
 * Whether a FIDO2 security key is plugged in. Only answerable on Linux (hidraw report descriptors);
 * `undefined` elsewhere or when sysfs can't be read, so callers keep their old behavior.
 */
export async function isFido2DeviceConnected(hidrawDir = HIDRAW_DIR): Promise<boolean | undefined> {
  if (hidrawDir === HIDRAW_DIR && process.platform !== 'linux') return undefined;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(hidrawDir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    try {
      const descriptor = await fs.promises.readFile(path.join(hidrawDir, entry, 'device', 'report_descriptor'));
      if (isFidoReportDescriptor(descriptor)) return true;
    } catch {
      // Not readable: skip this node.
    }
  }
  return false;
}
