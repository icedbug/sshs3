import { describe, it, expect } from 'vitest';
import { isSpecialFileMode } from '../../src/main/storage/sftp/sftpFileType';

describe('isSpecialFileMode', () => {
  it('flags FIFOs, sockets and character/block devices', () => {
    expect(isSpecialFileMode(0o010644)).toBe(true); // FIFO
    expect(isSpecialFileMode(0o140755)).toBe(true); // socket
    expect(isSpecialFileMode(0o020660)).toBe(true); // character device
    expect(isSpecialFileMode(0o060660)).toBe(true); // block device
  });

  it('does not flag regular files, directories and symlinks', () => {
    expect(isSpecialFileMode(0o100644)).toBe(false);
    expect(isSpecialFileMode(0o040755)).toBe(false);
    expect(isSpecialFileMode(0o120777)).toBe(false);
  });

  it('does not flag a server that reports no mode or only permission bits (type unknown)', () => {
    expect(isSpecialFileMode(undefined)).toBe(false);
    expect(isSpecialFileMode(0o644)).toBe(false);
  });
});
