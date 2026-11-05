/**
 * Building blocks of the SSH wire format (RFC 4251 data types) shared by the SSH CA code: public key blobs,
 * certificates and ssh-agent messages.
 */

function encodeUint32(val: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(val, 0);
  return b;
}

export function encodeSshString(data: Buffer | string): Buffer {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return Buffer.concat([encodeUint32(buf.length), buf]);
}

export function encodeMpint(bytesIn: Buffer): Buffer {
  let bytes = bytesIn;
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  bytes = bytes.subarray(i);
  if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 0)) {
    return encodeSshString(Buffer.alloc(0));
  }
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return encodeSshString(bytes);
}

export class BinaryReader {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  public get remaining(): number {
    return this.buffer.length - this.offset;
  }

  public readUint32(): number {
    if (this.remaining < 4) {
      throw new Error(`Unexpected EOF reading uint32 at offset ${this.offset}`);
    }
    const val = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return val;
  }

  public readUint64(): bigint {
    if (this.remaining < 8) {
      throw new Error(`Unexpected EOF reading uint64 at offset ${this.offset}`);
    }
    const val = this.buffer.readBigUInt64BE(this.offset);
    this.offset += 8;
    return val;
  }

  public readString(): string {
    return this.readBuffer().toString('utf8');
  }

  public readBuffer(): Buffer {
    const len = this.readUint32();
    if (this.remaining < len) {
      throw new Error(`Unexpected EOF reading buffer of length ${len} at offset ${this.offset}`);
    }
    const slice = this.buffer.subarray(this.offset, this.offset + len);
    this.offset += len;
    return slice;
  }
}

export class BinaryWriter {
  private chunks: Buffer[] = [];
  private totalLength = 0;

  public writeByte(val: number): void {
    const b = Buffer.alloc(1);
    b.writeUInt8(val, 0);
    this.chunks.push(b);
    this.totalLength += 1;
  }

  public writeUint32(val: number): void {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(val, 0);
    this.chunks.push(b);
    this.totalLength += 4;
  }

  public writeBuffer(buf: Buffer): void {
    this.writeUint32(buf.length);
    this.chunks.push(buf);
    this.totalLength += buf.length;
  }

  public writeString(str: string): void {
    this.writeBuffer(Buffer.from(str, 'utf8'));
  }

  /**
   * Produces the complete agent message packet with 4-byte big-endian length prefix.
   */
  public toMessage(): Buffer {
    const body = Buffer.concat(this.chunks, this.totalLength);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length, 0);
    return Buffer.concat([prefix, body]);
  }
}
