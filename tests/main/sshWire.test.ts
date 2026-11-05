import { describe, it, expect } from 'vitest';
import { BinaryReader, BinaryWriter, encodeMpint, encodeSshString } from '../../src/main/ca/sshWire';

describe('sshWire', () => {
  it('encodeSshString prefixes the byte length (strings are encoded as UTF-8)', () => {
    expect(encodeSshString('abc')).toEqual(Buffer.from([0, 0, 0, 3, 0x61, 0x62, 0x63]));
    expect(encodeSshString('å')).toEqual(Buffer.from([0, 0, 0, 2, 0xc3, 0xa5]));
    expect(encodeSshString(Buffer.alloc(0))).toEqual(Buffer.from([0, 0, 0, 0]));
  });

  it('encodeMpint strips leading zeros, keeps the value positive and encodes zero as the empty string', () => {
    expect(encodeMpint(Buffer.from([0, 0, 0x7f]))).toEqual(Buffer.from([0, 0, 0, 1, 0x7f]));
    expect(encodeMpint(Buffer.from([0x80]))).toEqual(Buffer.from([0, 0, 0, 2, 0x00, 0x80]));
    expect(encodeMpint(Buffer.from([0, 0]))).toEqual(Buffer.from([0, 0, 0, 0]));
  });

  it('BinaryWriter output is read back by BinaryReader', () => {
    const w = new BinaryWriter();
    w.writeByte(17);
    w.writeString('ssh-ed25519');
    w.writeBuffer(Buffer.from([1, 2, 3]));
    w.writeUint32(0xdeadbeef);

    const message = w.toMessage();
    expect(message.readUInt32BE(0)).toBe(message.length - 4);

    const body = message.subarray(4);
    expect(body[0]).toBe(17);
    const r = new BinaryReader(body.subarray(1));
    expect(r.readString()).toBe('ssh-ed25519');
    expect(r.readBuffer()).toEqual(Buffer.from([1, 2, 3]));
    expect(r.readUint32()).toBe(0xdeadbeef);
    expect(r.remaining).toBe(0);
  });

  it('BinaryReader reads uint64 and refuses to read past the end', () => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(2n ** 40n + 5n);
    expect(new BinaryReader(buf).readUint64()).toBe(2n ** 40n + 5n);

    expect(() => new BinaryReader(Buffer.from([0, 0])).readUint32()).toThrow(/Unexpected EOF/);
    expect(() => new BinaryReader(Buffer.from([0, 0, 0, 9, 1])).readBuffer()).toThrow(/Unexpected EOF/);
  });
});
