/**
 * SFTP v3 protocol constants and types based on draft-ietf-secsh-filexfer-02.
 */

export const FXP = {
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  WRITE: 6,
  LSTAT: 7,
  FSTAT: 8,
  SETSTAT: 9,
  FSETSTAT: 10,
  OPENDIR: 11,
  READDIR: 12,
  REMOVE: 13,
  MKDIR: 14,
  RMDIR: 15,
  REALPATH: 16,
  STAT: 17,
  RENAME: 18,
  READLINK: 19,
  SYMLINK: 20,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
  EXTENDED: 200,
  EXTENDED_REPLY: 201,
} as const;

export type FxpType = (typeof FXP)[keyof typeof FXP];

export const FXF = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020,
} as const;

export const ATTR = {
  SIZE: 0x00000001,
  UIDGID: 0x00000002,
  PERMISSIONS: 0x00000004,
  ACMODTIME: 0x00000008,
  EXTENDED: 0x80000000,
} as const;

export const FX_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

export type FxStatusCode = (typeof FX_STATUS)[keyof typeof FX_STATUS];

export const FX_STATUS_MESSAGE: Record<number, string> = {
  [FX_STATUS.OK]: 'Success',
  [FX_STATUS.EOF]: 'End of file',
  [FX_STATUS.NO_SUCH_FILE]: 'No such file or directory',
  [FX_STATUS.PERMISSION_DENIED]: 'Permission denied',
  [FX_STATUS.FAILURE]: 'Failure',
  [FX_STATUS.BAD_MESSAGE]: 'Bad message',
  [FX_STATUS.NO_CONNECTION]: 'No connection',
  [FX_STATUS.CONNECTION_LOST]: 'Connection lost',
  [FX_STATUS.OP_UNSUPPORTED]: 'Operation unsupported',
};

export interface SftpFileStats {
  size: number;
  uid?: number;
  gid?: number;
  mode?: number;
  atime?: number;
  mtime?: number;
  isDirectory: boolean;
  isSymlink: boolean;
  /** FIFO, socket or device (see `isSpecialFileMode`). */
  isSpecial?: boolean;
}

export interface SftpNameEntry {
  filename: string;
  longname: string;
  attrs: SftpFileStats;
}
