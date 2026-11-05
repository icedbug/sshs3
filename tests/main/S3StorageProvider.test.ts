import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { S3Config } from '../../src/shared/types/storage';
import { formatDate } from '../../src/main/storage/StorageProvider';
import { NodeHttpHandler } from '@smithy/node-http-handler';

// Shared state for AWS SDK mocks
const clientSendMock = vi.fn();
const clientDestroyMock = vi.fn();
const s3ClientConstructorMock = vi.fn();

let uploadParamsMock: any = null;
let uploadDoneMock = vi.fn();
let uploadAbortMock = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  class S3Client {
    public config: any;
    public send = clientSendMock;
    public destroy = clientDestroyMock;
    constructor(config: any) {
      this.config = config;
      s3ClientConstructorMock(config);
    }
  }

  class ListBucketsCommand {
    constructor(public input: any) {}
  }
  class ListObjectsV2Command {
    constructor(public input: any) {}
  }
  class HeadBucketCommand {
    constructor(public input: any) {}
  }
  class HeadObjectCommand {
    constructor(public input: any) {}
  }
  class CreateBucketCommand {
    constructor(public input: any) {}
  }
  class PutObjectCommand {
    constructor(public input: any) {}
  }
  class DeleteObjectCommand {
    constructor(public input: any) {}
  }
  class DeleteObjectsCommand {
    constructor(public input: any) {}
  }
  class DeleteBucketCommand {
    constructor(public input: any) {}
  }
  class CopyObjectCommand {
    constructor(public input: any) {}
  }
  class GetObjectCommand {
    constructor(public input: any) {}
  }
  class ListObjectVersionsCommand {
    constructor(public input: any) {}
  }

  return {
    S3Client,
    ListBucketsCommand,
    ListObjectsV2Command,
    HeadBucketCommand,
    HeadObjectCommand,
    CreateBucketCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    DeleteBucketCommand,
    CopyObjectCommand,
    GetObjectCommand,
    ListObjectVersionsCommand,
  };
});

vi.mock('@aws-sdk/lib-storage', () => {
  class Upload {
    public done = uploadDoneMock;
    public abort = uploadAbortMock;
    constructor(public options: any) {
      uploadParamsMock = options;
    }
  }

  return {
    Upload,
  };
});

const { getSignedUrlMock } = vi.hoisted(() => ({ getSignedUrlMock: vi.fn() }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: getSignedUrlMock,
}));

const { fromSSOMock } = vi.hoisted(() => ({ fromSSOMock: vi.fn() }));
vi.mock('@aws-sdk/credential-provider-sso', () => ({
  fromSSO: fromSSOMock,
}));

// Import the provider and helper under test
import { S3StorageProvider, parseS3Path } from '../../src/main/storage/S3StorageProvider';
import {
  ListBucketsCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  CopyObjectCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';

describe('S3StorageProvider', () => {
  let tempDir: string;
  const defaultS3Config: S3Config = {
    id: 'aws-test',
    name: 'AWS S3 Test',
    region: 'us-west-2',
    accessKeyId: 'TEST_ACCESS_KEY',
    secretAccessKey: 'TEST_SECRET_KEY',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    uploadParamsMock = null;
    uploadDoneMock = vi.fn().mockResolvedValue({ Location: 'https://s3.amazonaws.com/bucket/key' });
    uploadAbortMock = vi.fn();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multissh-s3-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('parseS3Path', () => {
    it('should parse root path ("" or "/") as empty bucket and key', () => {
      expect(parseS3Path('')).toEqual({ bucket: '', key: '' });
      expect(parseS3Path('/')).toEqual({ bucket: '', key: '' });
      expect(parseS3Path('///')).toEqual({ bucket: '', key: '' });
    });

    it('should parse bucket path without key', () => {
      expect(parseS3Path('/my-bucket')).toEqual({ bucket: 'my-bucket', key: '' });
      expect(parseS3Path('my-bucket')).toEqual({ bucket: 'my-bucket', key: '' });
      expect(parseS3Path('/my-bucket/')).toEqual({ bucket: 'my-bucket', key: '' });
    });

    it('should parse bucket with single level key', () => {
      expect(parseS3Path('/my-bucket/file.txt')).toEqual({
        bucket: 'my-bucket',
        key: 'file.txt',
      });
      expect(parseS3Path('/my-bucket/subfolder')).toEqual({
        bucket: 'my-bucket',
        key: 'subfolder',
      });
      expect(parseS3Path('/my-bucket/subfolder/')).toEqual({
        bucket: 'my-bucket',
        key: 'subfolder/',
      });
    });

    it('should parse bucket with nested deep path', () => {
      expect(parseS3Path('/my-bucket/path/to/nested/file.txt')).toEqual({
        bucket: 'my-bucket',
        key: 'path/to/nested/file.txt',
      });
    });

    it('should normalize Windows style backslashes', () => {
      expect(parseS3Path('\\my-bucket\\path\\to\\file.txt')).toEqual({
        bucket: 'my-bucket',
        key: 'path/to/file.txt',
      });
    });
  });

  describe('Initialization and Configuration', () => {
    it('should configure standard AWS S3 client with credentials and region', () => {
      const provider = new S3StorageProvider(defaultS3Config);

      expect(provider.id).toBe('aws-test');
      expect(provider.name).toBe('AWS S3 Test');
      expect(provider.type).toBe('s3');

      expect(s3ClientConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-west-2',
          forcePathStyle: true,
          credentials: {
            accessKeyId: 'TEST_ACCESS_KEY',
            secretAccessKey: 'TEST_SECRET_KEY',
          },
        })
      );
    });

    it('should fallback to us-east-1 when region is empty', () => {
      new S3StorageProvider({
        ...defaultS3Config,
        region: '',
      });

      expect(s3ClientConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
        })
      );
    });

    it('should configure MinIO client with endpoint and forcePathStyle', () => {
      const minioConfig: S3Config = {
        id: 'minio-local',
        name: 'MinIO Local',
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        accessKeyId: 'minioadmin',
        secretAccessKey: 'minioadmin',
        forcePathStyle: true,
      };

      const provider = new S3StorageProvider(minioConfig);
      expect(provider.id).toBe('minio-local');
      expect(s3ClientConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'http://localhost:9000',
          forcePathStyle: true,
          region: 'us-east-1',
          credentials: {
            accessKeyId: 'minioadmin',
            secretAccessKey: 'minioadmin',
          },
        })
      );
    });

    it('should configure NetApp with rejectUnauthorized: false and custom CA path', async () => {
      const caCertPath = path.join(tempDir, 'custom-ca.pem');
      const caContent = '-----BEGIN CERTIFICATE-----\nFAKE_CA_CONTENT\n-----END CERTIFICATE-----';
      await fs.writeFile(caCertPath, caContent, 'utf-8');

      const netappConfig: S3Config = {
        id: 'netapp-storagegrid',
        name: 'NetApp StorageGRID',
        endpoint: 'https://s3.netapp.corp:8082',
        region: 'us-east-1',
        accessKeyId: 'NETAPP_KEY',
        secretAccessKey: 'NETAPP_SECRET',
        forcePathStyle: true,
        rejectUnauthorized: false,
        customCaPath: caCertPath,
      };

      new S3StorageProvider(netappConfig);

      const passedConfig = s3ClientConstructorMock.mock.calls[0][0];
      expect(passedConfig.endpoint).toBe('https://s3.netapp.corp:8082');
      expect(passedConfig.requestHandler).toBeDefined();
      expect(passedConfig.requestHandler).toBeInstanceOf(NodeHttpHandler);

      // Verify httpsAgent config inside NodeHttpHandler
      const handlerConfig = await (passedConfig.requestHandler as any).configProvider;
      expect(handlerConfig.httpsAgent.options.rejectUnauthorized).toBe(false);
      expect(handlerConfig.httpsAgent.options.ca).toBeDefined();
      expect(handlerConfig.httpsAgent.options.ca.toString()).toBe(caContent);
    });

    it('should use fromSSO() as a credentials provider function when authMode is "sso"', () => {
      const fakeCredentialsProvider = vi.fn();
      fromSSOMock.mockReturnValueOnce(fakeCredentialsProvider);

      new S3StorageProvider({
        ...defaultS3Config,
        authMode: 'sso',
        sso: { startUrl: 'https://example.awsapps.com/start', region: 'us-east-1', accountId: '111', roleName: 'Admin' },
      });

      // The role-credential call must use the profile's proxy/CA-aware handler, not the SDK default.
      expect(fromSSOMock).toHaveBeenCalledWith({
        ssoStartUrl: 'https://example.awsapps.com/start',
        ssoRegion: 'us-east-1',
        ssoAccountId: '111',
        ssoRoleName: 'Admin',
        clientConfig: { requestHandler: expect.any(NodeHttpHandler) },
      });
      expect(s3ClientConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: fakeCredentialsProvider })
      );
    });

    it('should include sessionToken in credentials if provided', () => {
      new S3StorageProvider({
        ...defaultS3Config,
        sessionToken: 'TEMP_SESSION_TOKEN_123',
      });

      expect(s3ClientConstructorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: {
            accessKeyId: 'TEST_ACCESS_KEY',
            secretAccessKey: 'TEST_SECRET_KEY',
            sessionToken: 'TEMP_SESSION_TOKEN_123',
          },
        })
      );
    });
  });

  describe('list', () => {
    let provider: S3StorageProvider;

    beforeEach(() => {
      provider = new S3StorageProvider(defaultS3Config);
    });

    it('should list all buckets when path is "/" or "" using ListBucketsCommand', async () => {
      const creationDate = new Date('2026-09-14T10:00:00Z');
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof ListBucketsCommand) {
          return {
            Buckets: [
              { Name: 'alpha-bucket', CreationDate: creationDate },
              { Name: 'beta-bucket', CreationDate: creationDate },
            ],
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entries = await provider.list('/');
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        name: 'alpha-bucket',
        path: '/alpha-bucket',
        size: 0,
        isDirectory: true,
        mtime: formatDate(creationDate),
        mtimeMs: creationDate.getTime(),
      });
      expect(entries[1]).toEqual({
        name: 'beta-bucket',
        path: '/beta-bucket',
        size: 0,
        isDirectory: true,
        mtime: formatDate(creationDate),
        mtimeMs: creationDate.getTime(),
      });

      // Verify date format follows yyyy-mm-dd HH:mm
      expect(entries[0].mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('should return empty list when no buckets exist', async () => {
      clientSendMock.mockImplementationOnce(async () => ({ Buckets: [] }));
      const entries = await provider.list('');
      expect(entries).toEqual([]);
    });

    it('should list bucket contents with CommonPrefixes as directories and Contents as files', async () => {
      const fileDate = new Date('2026-09-14T12:30:00Z');
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof ListObjectsV2Command) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Prefix: '',
            Delimiter: '/',
            ContinuationToken: undefined,
          });
          return {
            CommonPrefixes: [{ Prefix: 'documents/' }, { Prefix: 'photos/' }],
            Contents: [
              { Key: 'readme.txt', Size: 256, LastModified: fileDate },
              { Key: 'archive.zip', Size: 2048, LastModified: fileDate },
            ],
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entries = await provider.list('/my-bucket');
      expect(entries).toHaveLength(4);

      // Directories sorted first
      expect(entries[0]).toEqual({
        name: 'documents',
        path: '/my-bucket/documents',
        size: 0,
        isDirectory: true,
        mtime: undefined,
      });
      expect(entries[1]).toEqual({
        name: 'photos',
        path: '/my-bucket/photos',
        size: 0,
        isDirectory: true,
        mtime: undefined,
      });

      // Files follow
      expect(entries[2]).toEqual({
        name: 'archive.zip',
        path: '/my-bucket/archive.zip',
        size: 2048,
        isDirectory: false,
        mtime: formatDate(fileDate),
        mtimeMs: fileDate.getTime(),
        mimeType: 'application/zip',
      });
      expect(entries[3]).toEqual({
        name: 'readme.txt',
        path: '/my-bucket/readme.txt',
        size: 256,
        isDirectory: false,
        mtime: formatDate(fileDate),
        mtimeMs: fileDate.getTime(),
        mimeType: 'text/plain',
      });
    });

    // LOW finding (code review): an S3 key is an opaque string — nothing
    // stops an object from actually being named e.g. "some/path/../file.txt"
    // or "some/path/./file.txt", which would otherwise surface as a virtual
    // "directory" literally named ".." or ".", looking exactly like a
    // parent-directory shortcut and confusing navigation/breadcrumb logic.
    it('filters out virtual ".." / "." directory entries and literal ".."/"." object keys', async () => {
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof ListObjectsV2Command) {
          return {
            CommonPrefixes: [{ Prefix: 'foo/../' }, { Prefix: 'foo/./' }, { Prefix: 'documents/' }],
            Contents: [{ Key: '..', Size: 0 }, { Key: '.', Size: 0 }, { Key: 'readme.txt', Size: 10 }],
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entries = await provider.list('/my-bucket');

      expect(entries.map((e) => e.name)).toEqual(['documents', 'readme.txt']);
    });

    it('should list subfolder contents and filter out folder marker object and trailing slash keys', async () => {
      const fileDate = new Date('2026-09-14T14:15:00Z');
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof ListObjectsV2Command) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Prefix: 'subfolder/',
            Delimiter: '/',
            ContinuationToken: undefined,
          });
          return {
            CommonPrefixes: [{ Prefix: 'subfolder/nested/' }],
            Contents: [
              // Directory marker object itself
              { Key: 'subfolder/', Size: 0, LastModified: fileDate },
              // Subfolder marker with trailing slash
              { Key: 'subfolder/another-dir/', Size: 0, LastModified: fileDate },
              // Actual file inside subfolder
              { Key: 'subfolder/notes.md', Size: 512, LastModified: fileDate },
            ],
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entries = await provider.list('/my-bucket/subfolder');
      expect(entries).toHaveLength(2);

      // CommonPrefix
      expect(entries[0]).toEqual({
        name: 'nested',
        path: '/my-bucket/subfolder/nested',
        size: 0,
        isDirectory: true,
        mtime: undefined,
      });

      // File - markers 'subfolder/' and 'subfolder/another-dir/' must be skipped
      expect(entries[1]).toEqual({
        name: 'notes.md',
        path: '/my-bucket/subfolder/notes.md',
        size: 512,
        isDirectory: false,
        mtime: formatDate(fileDate),
        mtimeMs: fileDate.getTime(),
        mimeType: 'text/markdown',
      });
    });

    it('should paginate using NextContinuationToken and ContinuationToken across multiple pages', async () => {
      const fileDate = new Date('2026-09-14T15:00:00Z');
      let callCount = 0;

      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof ListObjectsV2Command) {
          callCount++;
          if (callCount === 1) {
            expect(command.input.ContinuationToken).toBeUndefined();
            return {
              Contents: [{ Key: 'file1.txt', Size: 100, LastModified: fileDate }],
              NextContinuationToken: 'token-page-2',
            };
          }
          if (callCount === 2) {
            expect(command.input.ContinuationToken).toBe('token-page-2');
            return {
              Contents: [{ Key: 'file2.txt', Size: 200, LastModified: fileDate }],
              NextContinuationToken: undefined,
            };
          }
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entries = await provider.list('/my-bucket');
      expect(callCount).toBe(2);
      expect(entries).toHaveLength(2);
      expect(entries[0].name).toBe('file1.txt');
      expect(entries[1].name).toBe('file2.txt');
    });
  });

  describe('stat', () => {
    let provider: S3StorageProvider;

    beforeEach(() => {
      provider = new S3StorageProvider(defaultS3Config);
    });

    it('should stat root path as directory', async () => {
      const entry = await provider.stat('/');
      expect(entry).toEqual({
        name: '/',
        path: '/',
        size: 0,
        isDirectory: true,
      });
    });

    it('should stat a bucket via HeadBucketCommand', async () => {
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof HeadBucketCommand) {
          expect(command.input).toEqual({ Bucket: 'my-bucket' });
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entry = await provider.stat('/my-bucket');
      expect(entry).toEqual({
        name: 'my-bucket',
        path: '/my-bucket',
        size: 0,
        isDirectory: true,
      });
    });

    it('should stat an object via HeadObjectCommand', async () => {
      const modifiedDate = new Date('2026-09-14T09:00:00Z');
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof HeadObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'path/to/document.pdf',
          });
          return {
            ContentLength: 4096,
            LastModified: modifiedDate,
            ContentType: 'application/pdf',
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entry = await provider.stat('/my-bucket/path/to/document.pdf');
      expect(entry).toEqual({
        name: 'document.pdf',
        path: '/my-bucket/path/to/document.pdf',
        size: 4096,
        isDirectory: false,
        mtime: formatDate(modifiedDate),
        mtimeMs: modifiedDate.getTime(),
        mimeType: 'application/pdf',
      });
      expect(entry.mtime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    });

    it('should stat a virtual directory (prefix) when HeadObject throws NotFound', async () => {
      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof HeadObjectCommand) {
          const err: any = new Error('NotFound');
          err.name = 'NotFound';
          throw err;
        }
        if (command instanceof ListObjectsV2Command) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Prefix: 'virtual-folder/',
            MaxKeys: 1,
          });
          return {
            KeyCount: 1,
            Contents: [{ Key: 'virtual-folder/child.txt', Size: 10 }],
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entry = await provider.stat('/my-bucket/virtual-folder');
      expect(entry).toEqual({
        name: 'virtual-folder',
        path: '/my-bucket/virtual-folder',
        size: 0,
        isDirectory: true,
      });
    });

    it('should stat an explicit folder marker object (with trailing slash)', async () => {
      const folderDate = new Date('2026-09-14T11:20:00Z');
      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof HeadObjectCommand) {
          if (command.input.Key === 'explicit-folder/') {
            return {
              ContentLength: 0,
              LastModified: folderDate,
            };
          }
          const err: any = new Error('NotFound');
          err.name = 'NotFound';
          throw err;
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const entry = await provider.stat('/my-bucket/explicit-folder');
      expect(entry).toEqual({
        name: 'explicit-folder',
        path: '/my-bucket/explicit-folder',
        size: 0,
        isDirectory: true,
        mtime: formatDate(folderDate),
        mtimeMs: folderDate.getTime(),
      });
    });

    it('should throw error when path is neither object nor prefix', async () => {
      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof HeadObjectCommand) {
          const err: any = new Error('NotFound');
          err.name = 'NotFound';
          throw err;
        }
        if (command instanceof ListObjectsV2Command) {
          return {
            KeyCount: 0,
            Contents: [],
            CommonPrefixes: [],
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await expect(provider.stat('/my-bucket/non-existent-item')).rejects.toThrow(
        /Path not found/i
      );
    });
  });

  describe('createFolder', () => {
    let provider: S3StorageProvider;

    beforeEach(() => {
      provider = new S3StorageProvider(defaultS3Config);
    });

    it('should create a new bucket with LocationConstraint when region is not us-east-1', async () => {
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof CreateBucketCommand) {
          expect(command.input).toEqual({
            Bucket: 'brand-new-bucket',
            CreateBucketConfiguration: {
              LocationConstraint: 'us-west-2',
            },
          });
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.createFolder('/brand-new-bucket');
      expect(clientSendMock).toHaveBeenCalledTimes(1);
    });

    it('should create bucket without CreateBucketConfiguration when region is us-east-1', async () => {
      const eastProvider = new S3StorageProvider({
        ...defaultS3Config,
        region: 'us-east-1',
      });

      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof CreateBucketCommand) {
          expect(command.input).toEqual({
            Bucket: 'east-bucket',
          });
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await eastProvider.createFolder('/east-bucket');
      expect(clientSendMock).toHaveBeenCalledTimes(1);
    });

    it('should create virtual directory by putting an object with trailing slash', async () => {
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof PutObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'nested/virtual-folder/',
            Body: '',
            ContentLength: 0,
          });
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.createFolder('/my-bucket/nested/virtual-folder');
      expect(clientSendMock).toHaveBeenCalledTimes(1);
    });

    it('should preserve trailing slash if already provided', async () => {
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof PutObjectCommand) {
          expect(command.input.Key).toBe('subfolder/');
          expect(command.input.ContentLength).toBe(0);
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.createFolder('/my-bucket/subfolder/');
      expect(clientSendMock).toHaveBeenCalledTimes(1);
    });

    it('should throw error when trying to create folder at root', async () => {
      await expect(provider.createFolder('/')).rejects.toThrow(
        /Cannot create folder at root/i
      );
      await expect(provider.createFolder('')).rejects.toThrow(
        /Cannot create folder at root/i
      );
    });

    it('should include ServerSideEncryption: AES256 on the folder marker when configured', async () => {
      const sseProvider = new S3StorageProvider({ ...defaultS3Config, serverSideEncryption: 'AES256' });
      clientSendMock.mockImplementationOnce(async (command: any) => {
        expect(command.input).toMatchObject({ ServerSideEncryption: 'AES256' });
        expect(command.input.SSEKMSKeyId).toBeUndefined();
        return {};
      });

      await sseProvider.createFolder('/my-bucket/encrypted-folder');
    });

    it('should include ServerSideEncryption: aws:kms and SSEKMSKeyId on the folder marker when configured', async () => {
      const kmsProvider = new S3StorageProvider({
        ...defaultS3Config,
        serverSideEncryption: 'aws:kms',
        kmsKeyId: 'arn:aws:kms:us-west-2:111122223333:key/abc-123',
      });
      clientSendMock.mockImplementationOnce(async (command: any) => {
        expect(command.input).toMatchObject({
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: 'arn:aws:kms:us-west-2:111122223333:key/abc-123',
        });
        return {};
      });

      await kmsProvider.createFolder('/my-bucket/kms-folder');
    });
  });

  describe('delete', () => {
    let provider: S3StorageProvider;

    beforeEach(() => {
      provider = new S3StorageProvider(defaultS3Config);
    });

    it('should delete an object using DeleteObjectCommand when isDirectory is false', async () => {
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof DeleteObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'data/file.txt',
          });
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.delete('/my-bucket/data/file.txt', false);
      expect(clientSendMock).toHaveBeenCalledTimes(1);
    });

    it('should delete a bucket using DeleteBucketCommand when deleting bucket with isDirectory=true', async () => {
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof DeleteBucketCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
          });
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.delete('/my-bucket', true);
      expect(clientSendMock).toHaveBeenCalledTimes(1);
    });

    it('should delete a virtual folder and its objects using DeleteObjectsCommand with pagination', async () => {
      const deletedObjectBatches: any[] = [];
      let listCallCount = 0;

      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof ListObjectsV2Command) {
          listCallCount++;
          expect(command.input.Prefix).toBe('subfolder/');
          if (listCallCount === 1) {
            return {
              Contents: [{ Key: 'subfolder/file1.txt' }],
              NextContinuationToken: 'del-token-2',
            };
          }
          return {
            Contents: [{ Key: 'subfolder/file2.txt' }],
            NextContinuationToken: undefined,
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          if (command.input.Delete?.Objects) {
            deletedObjectBatches.push(command.input.Delete.Objects);
          }
          return {};
        }
        if (command instanceof DeleteObjectCommand) {
          // Folder marker cleanup
          expect(command.input.Key).toBe('subfolder/');
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.delete('/my-bucket/subfolder', true);
      expect(deletedObjectBatches).toEqual([
        [{ Key: 'subfolder/file1.txt' }],
        [{ Key: 'subfolder/file2.txt' }],
      ]);
    });

    it('should delete a versioned folder, all its versions and delete markers', async () => {
      const deletedObjectBatches: any[] = [];

      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof ListObjectVersionsCommand) {
          expect(command.input.Prefix).toBe('versioned-folder/');
          return {
            Versions: [
              { Key: 'versioned-folder/file1.txt', VersionId: 'v1' },
              { Key: 'versioned-folder/file1.txt', VersionId: 'v2' },
            ],
            DeleteMarkers: [{ Key: 'versioned-folder/file2.txt', VersionId: 'm1' }],
            IsTruncated: false,
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          if (command.input.Delete?.Objects) {
            deletedObjectBatches.push(command.input.Delete.Objects);
          }
          return { Deleted: command.input.Delete?.Objects };
        }
        if (command instanceof DeleteObjectCommand) {
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.delete('/my-bucket/versioned-folder', true);
      expect(deletedObjectBatches).toEqual([
        [
          { Key: 'versioned-folder/file1.txt', VersionId: 'v1' },
          { Key: 'versioned-folder/file1.txt', VersionId: 'v2' },
          { Key: 'versioned-folder/file2.txt', VersionId: 'm1' },
        ],
      ]);
    });

    it('should throw error when DeleteObjectsCommand returns errors in response', async () => {
      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof ListObjectVersionsCommand) {
          return {
            Versions: [{ Key: 'subfolder/file1.txt', VersionId: 'v1' }],
            IsTruncated: false,
          };
        }
        if (command instanceof DeleteObjectsCommand) {
          return {
            Errors: [
              {
                Key: 'subfolder/file1.txt',
                Code: 'AccessDenied',
                Message: 'Access Denied',
              },
            ],
          };
        }
        if (command instanceof DeleteObjectCommand) {
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await expect(provider.delete('/my-bucket/subfolder', true)).rejects.toThrow(
        /Failed to delete 1 object\(s\) in S3: subfolder\/file1.txt \(AccessDenied: Access Denied\)/
      );
    });

    it('should throw error when deleting root', async () => {
      await expect(provider.delete('/', true)).rejects.toThrow(/Cannot delete root/i);
      await expect(provider.delete('', false)).rejects.toThrow(/Cannot delete root/i);
    });

    it('should throw error when deleting bucket with isDirectory=false', async () => {
      await expect(provider.delete('/my-bucket', false)).rejects.toThrow(
        /Expected file but found bucket/i
      );
    });
  });

  describe('rename', () => {
    let provider: S3StorageProvider;

    beforeEach(() => {
      provider = new S3StorageProvider(defaultS3Config);
    });

    it('should rename object via CopyObjectCommand and DeleteObjectCommand', async () => {
      const executedCommands: string[] = [];
      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof CopyObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'new-name.txt',
            CopySource: 'my-bucket/old-name.txt',
          });
          executedCommands.push('copy');
          return {};
        }
        if (command instanceof DeleteObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'old-name.txt',
          });
          executedCommands.push('delete');
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.rename('/my-bucket/old-name.txt', '/my-bucket/new-name.txt');
      expect(executedCommands).toEqual(['copy', 'delete']);
    });

    it('should properly URL-encode CopySource with spaces and special characters', async () => {
      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof CopyObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'destination.txt',
            CopySource: 'my-bucket/nested%20folder/special%20name%20%231%20%2B%202.txt',
          });
          return {};
        }
        if (command instanceof DeleteObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'nested folder/special name #1 + 2.txt',
          });
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.rename(
        '/my-bucket/nested folder/special name #1 + 2.txt',
        '/my-bucket/destination.txt'
      );
      expect(clientSendMock).toHaveBeenCalledTimes(2);
    });

    it('should support rename / move across different buckets', async () => {
      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof CopyObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'destination-bucket',
            Key: 'target.txt',
            CopySource: 'source-bucket/source.txt',
          });
          return {};
        }
        if (command instanceof DeleteObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'source-bucket',
            Key: 'source.txt',
          });
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.rename('/source-bucket/source.txt', '/destination-bucket/target.txt');
      expect(clientSendMock).toHaveBeenCalledTimes(2);
    });

    it('should throw error when source or destination is root or invalid', async () => {
      await expect(provider.rename('/', '/target')).rejects.toThrow(
        /Cannot rename root or bucket directly/i
      );
      await expect(provider.rename('/my-bucket', '/target')).rejects.toThrow(
        /Cannot rename root or bucket directly/i
      );
      await expect(provider.rename('/my-bucket/file.txt', '/')).rejects.toThrow(
        /Destination must include bucket and key/i
      );
    });

    it('should include ServerSideEncryption/SSEKMSKeyId in CopyObjectCommand when configured', async () => {
      const kmsProvider = new S3StorageProvider({
        ...defaultS3Config,
        serverSideEncryption: 'aws:kms',
        kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/test',
      });

      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof CopyObjectCommand) {
          expect(command.input).toMatchObject({
            ServerSideEncryption: 'aws:kms',
            SSEKMSKeyId: 'arn:aws:kms:us-east-1:123456789012:key/test',
          });
          return {};
        }
        if (command instanceof DeleteObjectCommand) {
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await kmsProvider.rename('/my-bucket/file.txt', '/my-bucket/renamed.txt');
      expect(clientSendMock).toHaveBeenCalledTimes(2);
    });

    it('should retry CopyObjectCommand when receiving NoSuchKey due to eventual consistency', async () => {
      let attempts = 0;
      clientSendMock.mockImplementation(async (command: any) => {
        if (command instanceof CopyObjectCommand) {
          attempts++;
          if (attempts === 1) {
            const err: any = new Error('The specified key does not exist.');
            err.name = 'NoSuchKey';
            throw err;
          }
          return {};
        }
        if (command instanceof DeleteObjectCommand) {
          return {};
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.rename('/my-bucket/old.txt', '/my-bucket/new.txt');
      expect(attempts).toBe(2);
      expect(clientSendMock).toHaveBeenCalledTimes(3); // 2 copy attempts + 1 delete
    });
  });

  describe('createReadStream', () => {
    let provider: S3StorageProvider;

    beforeEach(() => {
      provider = new S3StorageProvider(defaultS3Config);
    });

    it('should create readable stream via GetObjectCommand for whole file', async () => {
      const mockStream = Readable.from(['Hello ', 'from ', 'S3!']);
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof GetObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'hello.txt',
          });
          return {
            Body: mockStream,
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const stream = await provider.createReadStream('/my-bucket/hello.txt');
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      expect(Buffer.concat(chunks).toString('utf-8')).toBe('Hello from S3!');
    });

    it('should pass byte range to GetObjectCommand when start and end are provided', async () => {
      const mockStream = Readable.from(['range-data']);
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof GetObjectCommand) {
          expect(command.input).toEqual({
            Bucket: 'my-bucket',
            Key: 'data.bin',
            Range: 'bytes=0-99',
          });
          return {
            Body: mockStream,
          };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      const stream = await provider.createReadStream('/my-bucket/data.bin', 0, 99);
      expect(stream).toBeDefined();
    });

    it('should support start-only byte range (Range: bytes=start-)', async () => {
      const mockStream = Readable.from(['rest-of-file']);
      clientSendMock.mockImplementationOnce(async (command: any) => {
        if (command instanceof GetObjectCommand) {
          expect(command.input.Range).toBe('bytes=100-');
          return { Body: mockStream };
        }
        throw new Error(`Unexpected command: ${command.constructor.name}`);
      });

      await provider.createReadStream('/my-bucket/data.bin', 100);
      expect(clientSendMock).toHaveBeenCalledTimes(1);
    });

    it('should throw error when reading root or bucket', async () => {
      await expect(provider.createReadStream('/')).rejects.toThrow(
        /Cannot read root or bucket as stream/i
      );
      await expect(provider.createReadStream('/my-bucket')).rejects.toThrow(
        /Cannot read root or bucket as stream/i
      );
    });

    it('should throw error if response body is empty', async () => {
      clientSendMock.mockImplementationOnce(async () => ({ Body: null }));
      await expect(provider.createReadStream('/my-bucket/empty.txt')).rejects.toThrow(
        /Empty response body/i
      );
    });
  });

  describe('createWriteStream', () => {
    let provider: S3StorageProvider;

    beforeEach(() => {
      provider = new S3StorageProvider(defaultS3Config);
    });

    it('should upload via @aws-sdk/lib-storage Upload connected to PassThrough stream and complete on finish', async () => {
      let uploadFinished = false;
      uploadDoneMock = vi.fn().mockImplementation(async () => {
        uploadFinished = true;
        return { Location: 'https://s3.amazonaws.com/bucket/output.txt' };
      });

      const writeStream = await provider.createWriteStream('/my-bucket/output.txt');
      expect(writeStream).toBeInstanceOf(PassThrough);

      expect(uploadParamsMock).toBeDefined();
      expect(uploadParamsMock.params).toEqual(
        expect.objectContaining({
          Bucket: 'my-bucket',
          Key: 'output.txt',
          Body: writeStream,
          ContentType: 'text/plain',
        })
      );

      // Write data to stream and ensure 'finish' only occurs after upload.done()
      let finishFired = false;
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => {
          finishFired = true;
          expect(uploadFinished).toBe(true);
          resolve();
        });
        writeStream.on('error', (err) => reject(err));
        writeStream.write('Streamed content to S3');
        writeStream.end();
      });

      expect(finishFired).toBe(true);
      expect(uploadDoneMock).toHaveBeenCalled();
    });

    it('reports the object as touched only after the upload has completed (H2)', async () => {
      let release!: () => void;
      uploadDoneMock = vi.fn().mockImplementation(
        () => new Promise((resolve) => { release = () => resolve({}); })
      );
      const writeStream = (await provider.createWriteStream('/my-bucket/o.txt')) as NodeJS.WritableStream & { targetTouched: boolean };

      writeStream.write('partial');
      expect(writeStream.targetTouched).toBe(false);

      release();
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
        writeStream.end();
      });
      expect(writeStream.targetTouched).toBe(true);
    });

    it('stays untouched when the upload fails, so the old object is kept (H2)', async () => {
      uploadDoneMock = vi.fn().mockRejectedValue(new Error('S3 upload failed'));
      const writeStream = (await provider.createWriteStream('/my-bucket/o.txt')) as NodeJS.WritableStream & { targetTouched: boolean };
      const failed = new Promise<void>((resolve) => writeStream.on('error', () => resolve()));
      writeStream.end('x');
      await failed;
      expect(writeStream.targetTouched).toBe(false);
    });

    it('should emit error on writeStream when upload.done() rejects during final', async () => {
      const uploadError = new Error('S3 upload failed');
      uploadDoneMock = vi.fn().mockRejectedValue(uploadError);

      const writeStream = await provider.createWriteStream('/my-bucket/error-upload.txt');

      const errorPromise = new Promise<Error>((resolve) => {
        writeStream.on('error', (err) => resolve(err));
      });

      writeStream.write('test data');
      writeStream.end();

      const receivedError = await errorPromise;
      expect(receivedError).toBe(uploadError);
    });

    it('should include ServerSideEncryption/SSEKMSKeyId in Upload params when configured', async () => {
      const kmsProvider = new S3StorageProvider({
        ...defaultS3Config,
        serverSideEncryption: 'aws:kms',
        kmsKeyId: 'arn:aws:kms:us-west-2:111122223333:key/abc-123',
      });
      uploadDoneMock = vi.fn().mockResolvedValue({ Location: 'https://s3.amazonaws.com/bucket/kms.txt' });

      const writeStream = await kmsProvider.createWriteStream('/my-bucket/kms.txt');
      expect(uploadParamsMock.params).toEqual(
        expect.objectContaining({
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: 'arn:aws:kms:us-west-2:111122223333:key/abc-123',
        })
      );

      writeStream.end();
      await new Promise<void>((resolve) => writeStream.on('finish', resolve));
    });

    it('should omit SSE params entirely when serverSideEncryption is unset', async () => {
      uploadDoneMock = vi.fn().mockResolvedValue({ Location: 'https://s3.amazonaws.com/bucket/plain.txt' });
      const writeStream = await provider.createWriteStream('/my-bucket/plain.txt');

      expect(uploadParamsMock.params.ServerSideEncryption).toBeUndefined();
      expect(uploadParamsMock.params.SSEKMSKeyId).toBeUndefined();

      writeStream.end();
      await new Promise<void>((resolve) => writeStream.on('finish', resolve));
    });

    it('should pass ContentLength when size option is provided and start upload immediately', async () => {
      uploadDoneMock = vi.fn().mockResolvedValue({ Location: 'https://s3.amazonaws.com/bucket/sized.bin' });

      const writeStream = await provider.createWriteStream('/my-bucket/sized.bin', { size: 1048576 });
      expect(writeStream).toBeInstanceOf(PassThrough);

      expect(uploadParamsMock.params).toEqual(
        expect.objectContaining({
          Bucket: 'my-bucket',
          Key: 'sized.bin',
          ContentLength: 1048576,
        })
      );

      // upload.done() is called immediately to consume the stream and prevent deadlock
      expect(uploadDoneMock).toHaveBeenCalledTimes(1);

      writeStream.end();
      await new Promise<void>((resolve) => writeStream.on('finish', resolve));
    });

    it('should abort upload when stream emits error', async () => {
      const writeStream = await provider.createWriteStream('/my-bucket/abort-upload.txt');

      // Trigger stream error
      (writeStream as PassThrough).destroy(new Error('Consumer abort'));

      // Wait a tick for event handlers
      await new Promise((r) => setTimeout(r, 10));
      expect(uploadAbortMock).toHaveBeenCalledTimes(1);
    });

    it('aborts the multipart upload when the transfer pipeline is aborted or its source fails', async () => {
      // pipeline() destroys the sink with the error that ended it, so the sink's 'error' handler runs.
      const ac = new AbortController();
      const aborted = await provider.createWriteStream('/my-bucket/aborted.bin');
      const source = Readable.from(
        (async function* () {
          for (;;) {
            yield Buffer.alloc(8);
            await new Promise((r) => setTimeout(r, 2));
          }
        })()
      );
      setTimeout(() => ac.abort(), 10);
      await expect(pipeline(source, aborted, { signal: ac.signal })).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      expect(uploadAbortMock).toHaveBeenCalledTimes(1);

      uploadAbortMock.mockClear();
      const failed = await provider.createWriteStream('/my-bucket/failed.bin');
      const failing = Readable.from(
        (async function* () {
          yield Buffer.alloc(8);
          throw new Error('read failed');
        })()
      );
      await expect(pipeline(failing, failed)).rejects.toThrow('read failed');
      await new Promise((r) => setTimeout(r, 10));
      expect(uploadAbortMock).toHaveBeenCalledTimes(1);
    });

    it('should throw error when writing to root or bucket without key', async () => {
      await expect(provider.createWriteStream('/')).rejects.toThrow(
        /Cannot write to root or bucket/i
      );
      await expect(provider.createWriteStream('/my-bucket')).rejects.toThrow(
        /Cannot write to root or bucket/i
      );
    });
  });

  describe('disconnect', () => {
    it('should destroy client when disconnect is called', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      await provider.disconnect();
      expect(clientDestroyMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('directory listing cache', () => {
    it('should return cached entries on repeated list() calls within TTL', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      clientSendMock.mockResolvedValueOnce({
        Buckets: [{ Name: 'cached-bucket', CreationDate: new Date() }],
      });

      const first = await provider.list('/');
      expect(first).toHaveLength(1);
      expect(clientSendMock).toHaveBeenCalledTimes(1);

      // Second call within TTL should return from cache without re-querying S3
      const second = await provider.list('/');
      expect(second).toEqual(first);
      expect(clientSendMock).toHaveBeenCalledTimes(1);
    });

    it('should bypass cache when force option is true', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      clientSendMock
        .mockResolvedValueOnce({ Buckets: [{ Name: 'bucket-1' }] })
        .mockResolvedValueOnce({ Buckets: [{ Name: 'bucket-1' }, { Name: 'bucket-2' }] });

      const first = await provider.list('/');
      expect(first).toHaveLength(1);

      const second = await provider.list('/', { force: true });
      expect(second).toHaveLength(2);
      expect(clientSendMock).toHaveBeenCalledTimes(2);
    });

    it('should invalidate cache on createFolder', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      clientSendMock
        .mockResolvedValueOnce({ Buckets: [{ Name: 'b1' }] })
        .mockResolvedValueOnce({}) // CreateBucketCommand
        .mockResolvedValueOnce({ Buckets: [{ Name: 'b1' }, { Name: 'b2' }] });

      await provider.list('/');
      expect(clientSendMock).toHaveBeenCalledTimes(1);

      await provider.createFolder('/b2');
      expect(clientSendMock).toHaveBeenCalledTimes(2);

      const afterCreate = await provider.list('/');
      expect(afterCreate).toHaveLength(2);
      expect(clientSendMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('getPresignedUrl', () => {
    it('should generate a signed URL for an object using the requested expiry', async () => {
      getSignedUrlMock.mockResolvedValueOnce('https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc');
      const provider = new S3StorageProvider(defaultS3Config);

      const url = await provider.getPresignedUrl('/my-bucket/path/to/file.txt', 3600);

      expect(url).toBe('https://bucket.s3.amazonaws.com/key?X-Amz-Signature=abc');
      expect(getSignedUrlMock).toHaveBeenCalledTimes(1);
      const [clientArg, commandArg, optionsArg] = getSignedUrlMock.mock.calls[0];
      expect(clientArg).toBe(provider.client);
      expect(commandArg.input).toEqual({ Bucket: 'my-bucket', Key: 'path/to/file.txt' });
      expect(optionsArg).toEqual({ expiresIn: 3600 });
    });

    it('should clamp expiry to the SigV4 maximum of 7 days', async () => {
      getSignedUrlMock.mockResolvedValueOnce('https://example.com/signed');
      const provider = new S3StorageProvider(defaultS3Config);

      await provider.getPresignedUrl('/my-bucket/file.txt', 999 * 24 * 60 * 60);

      const optionsArg = getSignedUrlMock.mock.calls[0][2];
      expect(optionsArg.expiresIn).toBe(7 * 24 * 60 * 60);
    });

    it('should reject a bucket-root path (no object key)', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      await expect(provider.getPresignedUrl('/my-bucket', 3600)).rejects.toThrow('Requires an object path');
      expect(getSignedUrlMock).not.toHaveBeenCalled();
    });
  });

  describe('writeFile', () => {
    it('should write buffer directly using PutObjectCommand', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      clientSendMock.mockResolvedValueOnce({});

      const data = Buffer.from('hello direct upload');
      await provider.writeFile('/my-bucket/test.txt', data);

      expect(clientSendMock).toHaveBeenCalledTimes(1);
      const command = clientSendMock.mock.calls[0][0];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toEqual(
        expect.objectContaining({
          Bucket: 'my-bucket',
          Key: 'test.txt',
          Body: data,
          ContentType: 'text/plain',
          ContentLength: data.byteLength,
        })
      );
    });

    it('should reject writing to root or bucket-only path', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      await expect(provider.writeFile('/', Buffer.from('test'))).rejects.toThrow(/Cannot write to root or bucket/i);
      await expect(provider.writeFile('/my-bucket', Buffer.from('test'))).rejects.toThrow(/Cannot write to root or bucket/i);
    });
  });

  describe('readFile', () => {
    it('should read file directly using GetObjectCommand', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      const content = Buffer.from('retrieved content');
      clientSendMock.mockResolvedValueOnce({
        Body: {
          transformToByteArray: async () => new Uint8Array(content),
        },
      });

      const result = await provider.readFile('/my-bucket/test.txt');

      expect(clientSendMock).toHaveBeenCalledTimes(1);
      const command = clientSendMock.mock.calls[0][0];
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input).toEqual({
        Bucket: 'my-bucket',
        Key: 'test.txt',
      });
      expect(result).toEqual(content);
    });

    it('should return empty buffer if response body is empty', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      clientSendMock.mockResolvedValueOnce({});

      const result = await provider.readFile('/my-bucket/empty.txt');
      expect(result).toEqual(Buffer.alloc(0));
    });

    it('should reject reading from root or bucket-only path', async () => {
      const provider = new S3StorageProvider(defaultS3Config);
      await expect(provider.readFile('/')).rejects.toThrow(/Cannot read root or bucket as file/i);
      await expect(provider.readFile('/my-bucket')).rejects.toThrow(/Cannot read root or bucket as file/i);
    });
  });
});

