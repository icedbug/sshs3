import path from 'node:path';
import type {
  FileEntry,
  IStorageProvider,
  StorageType,
  TransferProgress,
  WriteStreamOptions,
  SFTPConfig,
  SFTPAuthType,
  S3Config,
} from '../../shared/types/storage';

/**
 * Format a Date object to yyyy-mm-dd HH:mm (24h) format.
 */
export function formatDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

const MIME_MAP: Record<string, string> = {
  // Plain text & markup
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.sh': 'application/x-sh',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',

  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',

  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.7z': 'application/x-7z-compressed',

  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

  // Media
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/**
 * Returns a MIME type guess for the given file name or path.
 */
export function getMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext];
}

/**
 * Abstract base class for storage providers.
 */
export abstract class BaseStorageProvider implements IStorageProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly type: StorageType;

  abstract list(remotePath: string): Promise<FileEntry[]>;
  abstract stat(remotePath: string): Promise<FileEntry>;
  abstract createFolder(remotePath: string): Promise<void>;
  abstract delete(remotePath: string, isDirectory: boolean): Promise<void>;
  abstract rename(oldPath: string, newPath: string): Promise<void>;
  abstract createReadStream(remotePath: string, start?: number, end?: number): Promise<NodeJS.ReadableStream>;
  abstract createWriteStream(remotePath: string, options?: WriteStreamOptions): Promise<NodeJS.WritableStream>;
  getChecksum?(remotePath: string, algorithm?: 'sha256' | 'md5'): Promise<string | undefined>;
  abstract disconnect?(): Promise<void>;
}

export { BaseStorageProvider as StorageProvider };
export type {
  FileEntry,
  IStorageProvider,
  StorageType,
  TransferProgress,
  WriteStreamOptions,
  SFTPConfig,
  SFTPAuthType,
  S3Config,
};
