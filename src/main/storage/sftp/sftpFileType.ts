/**
 * True when an SFTP `mode` says the entry is neither a regular file, a directory nor a symlink: a FIFO, a socket
 * or a character/block device. Opening one of those for reading blocks (a FIFO waits for a writer) or never ends,
 * so transfers skip them. A server that reports no mode, or only permission bits, gives no file type: not special.
 */
export function isSpecialFileMode(mode: number | undefined): boolean {
  if (mode === undefined) return false;
  const type = mode & 0o170000;
  return type !== 0 && type !== 0o100000 && type !== 0o040000 && type !== 0o120000;
}
