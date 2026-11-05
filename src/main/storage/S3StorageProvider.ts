import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  S3Client,
  type S3ClientConfig,
  ListBucketsCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  HeadBucketCommand,
  HeadObjectCommand,
  CreateBucketCommand,
  type CreateBucketCommandInput,
  type BucketLocationConstraint,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  CopyObjectCommand,
  GetObjectCommand,
  type GetObjectCommandInput,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
  DeleteObjectTaggingCommand,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
  DeleteBucketTaggingCommand,
  GetBucketPolicyCommand,
  PutBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fromSSO } from '@aws-sdk/credential-provider-sso';
import { buildAwsNodeHttpHandler } from '../aws/buildAwsNodeHttpHandler';
import { describeS3Error, isAwsCredentialsError, isAwsSsoSessionError } from '../aws/awsErrors';
import { createLogger } from '../log';
import {
  BaseStorageProvider,
  formatDate,
  getMimeType,
} from './StorageProvider';
import type {
  BucketVersioningInfo,
  FileEntry,
  IStorageProvider,
  ObjectMetadata,
  ObjectVersionEntry,
  S3Config,
  S3Tag,
  StorageType,
  WriteStreamOptions,
} from '../../shared/types/storage';
import { defineTargetTouched } from './targetTouched';

/**
 * Parses a remote S3 path into bucket and key components.
 * Examples:
 * - "" or "/" -> { bucket: "", key: "" }
 * - "/bucket" -> { bucket: "bucket", key: "" }
 * - "/bucket/path/to/file.txt" -> { bucket: "bucket", key: "path/to/file.txt" }
 */
export function parseS3Path(remotePath: string): { bucket: string; key: string } {
  if (!remotePath) {
    return { bucket: '', key: '' };
  }
  const normalized = remotePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) {
    return { bucket: '', key: '' };
  }
  const slashIndex = normalized.indexOf('/');
  if (slashIndex === -1) {
    return { bucket: normalized, key: '' };
  }
  const bucket = normalized.slice(0, slashIndex);
  const key = normalized.slice(slashIndex + 1);
  return { bucket, key };
}

/** A stalled proxy/TLS handshake should fail visibly instead of leaving the pane loading forever. */
const S3_CONNECTION_TIMEOUT_MS = 15_000;
const s3Log = createLogger('s3');

export class S3StorageProvider extends BaseStorageProvider implements IStorageProvider {
  readonly id: string;
  readonly name: string;
  readonly type: StorageType = 's3';
  readonly config: S3Config;
  public readonly client: S3Client;

  constructor(config: S3Config) {
    super();
    this.id = config.id;
    this.name = config.name;
    this.config = config;

    const networkOptions = {
      customCaPath: config.customCaPath,
      rejectUnauthorized: config.rejectUnauthorized,
      proxy: config.proxy,
    };

    const s3ClientConfig: S3ClientConfig = {
      region: config.region || 'us-east-1',
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? true,
      credentials:
        config.authMode === 'sso' && config.sso
          ? fromSSO({
              ssoStartUrl: config.sso.startUrl,
              ssoRegion: config.sso.region,
              ssoAccountId: config.sso.accountId,
              ssoRoleName: config.sso.roleName,
              // Without this the role-credential call goes straight out, ignoring the profile's proxy/CA, and hangs.
              clientConfig: {
                requestHandler: buildAwsNodeHttpHandler(networkOptions),
              },
            })
          : {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
              ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
            },
    };

    // Same proxy/CA handling as the SSO calls. No request timeout: transfers may run long.
    s3ClientConfig.requestHandler = buildAwsNodeHttpHandler(networkOptions, {
      connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
    });

    this.client = new S3Client(s3ClientConfig);

    if (config.authMode === 'sso') {
      // Every operation (not just listing) reports a lapsed SSO session the same way, so the pane can offer a sign-in.
      this.client.middlewareStack?.add(
        (next) => async (args) => {
          try {
            return await next(args);
          } catch (err) {
            if (isAwsSsoSessionError(err) || isAwsCredentialsError(err)) {
              const e = err as Error;
              s3Log.warn(`SSO credential problem for "${config.name}": ${e.name}: ${e.message}`);
              throw new Error(describeS3Error(err, true), { cause: err });
            }
            throw err;
          }
        },
        { step: 'initialize', name: 'ssoSessionErrorTranslator', priority: 'high' }
      );
    }
  }

  private listCache: Map<string, { entries: FileEntry[]; timestamp: number }> = new Map();
  public static readonly CACHE_TTL_MS = 60_000;

  public clearCache(): void {
    this.listCache.clear();
  }

  /** Server-side encryption params to apply to every PutObject/Upload call, per the profile's config. */
  private sseParams(): { ServerSideEncryption?: 'AES256' | 'aws:kms'; SSEKMSKeyId?: string } {
    const sse = this.config.serverSideEncryption;
    if (!sse || sse === 'none') {
      return {};
    }
    return {
      ServerSideEncryption: sse,
      ...(sse === 'aws:kms' && this.config.kmsKeyId ? { SSEKMSKeyId: this.config.kmsKeyId } : {}),
    };
  }

  async list(remotePath: string, options?: { force?: boolean }): Promise<FileEntry[]> {
    const normalizedPath = remotePath.replace(/\\/g, '/');
    if (!options?.force) {
      const cached = this.listCache.get(normalizedPath);
      if (cached && Date.now() - cached.timestamp < S3StorageProvider.CACHE_TTL_MS) {
        return cached.entries;
      }
    }

    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket) {
      const output = await this.client.send(new ListBucketsCommand({}));
      const buckets = output.Buckets ?? [];
      const results: FileEntry[] = buckets.map((b) => ({
        name: b.Name ?? '',
        path: `/${b.Name ?? ''}`,
        size: 0,
        isDirectory: true,
        mtime: b.CreationDate ? formatDate(b.CreationDate) : undefined,
        mtimeMs: b.CreationDate ? b.CreationDate.getTime() : undefined,
      }));
      results.sort((a, b) => a.name.localeCompare(b.name));
      this.listCache.set(normalizedPath, { entries: results, timestamp: Date.now() });
      return results;
    }

    const prefix = key ? (key.endsWith('/') ? key : `${key}/`) : '';
    let continuationToken: string | undefined = undefined;
    const results: FileEntry[] = [];

    do {
      const command: ListObjectsV2Command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken,
      });
      const output = await this.client.send(command);

      // Virtual directories (CommonPrefixes)
      for (const cp of output.CommonPrefixes ?? []) {
        const cpPrefix = cp.Prefix ?? '';
        const stripped = cpPrefix.replace(/\/+$/, '');
        const name = path.posix.basename(stripped);
        // S3 keys are opaque strings — nothing stops an object from
        // actually being named e.g. "some/path/../file.txt", which would
        // surface here as a virtual "directory" literally named ".." (or
        // "."). No real security boundary is at risk (S3 has no directory
        // tree for ".." to escape), but showing it would look exactly like
        // a parent-directory shortcut and confuse navigation/breadcrumb
        // logic that assumes a directory name is a real path segment (LOW
        // finding, code review) — so it's left out of the listing.
        if (name === '..' || name === '.') {
          continue;
        }
        results.push({
          name,
          path: `/${bucket}/${stripped}`,
          size: 0,
          isDirectory: true,
          mtime: undefined,
        });
      }

      // Objects (Contents)
      for (const item of output.Contents ?? []) {
        const itemKey = item.Key ?? '';
        // Skip the folder marker itself or any key ending with '/'
        if (itemKey === prefix || itemKey === '' || itemKey.endsWith('/')) {
          continue;
        }
        const name = path.posix.basename(itemKey);
        if (name === '..' || name === '.') {
          continue;
        }
        results.push({
          name,
          path: `/${bucket}/${itemKey}`,
          size: item.Size ?? 0,
          isDirectory: false,
          mtime: item.LastModified ? formatDate(item.LastModified) : undefined,
          mtimeMs: item.LastModified ? item.LastModified.getTime() : undefined,
          mimeType: getMimeType(name),
        });
      }

      continuationToken = output.NextContinuationToken;
    } while (continuationToken);

    // Sort: directories first, then alphabetical
    results.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    this.listCache.set(normalizedPath, { entries: results, timestamp: Date.now() });
    return results;
  }

  async stat(remotePath: string): Promise<FileEntry> {
    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket) {
      return {
        name: '/',
        path: '/',
        size: 0,
        isDirectory: true,
      };
    }

    if (!key) {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return {
        name: bucket,
        path: `/${bucket}`,
        size: 0,
        isDirectory: true,
      };
    }

    const cleanKey = key.replace(/\/+$/, '');
    const isExplicitDir = key.endsWith('/');

    // 1. If not explicitly ending with '/', check if it's an object file
    if (!isExplicitDir) {
      try {
        const head = await this.client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: cleanKey })
        );
        const name = path.posix.basename(cleanKey);
        return {
          name,
          path: `/${bucket}/${cleanKey}`,
          size: head.ContentLength ?? 0,
          isDirectory: false,
          mtime: head.LastModified ? formatDate(head.LastModified) : undefined,
          mtimeMs: head.LastModified ? head.LastModified.getTime() : undefined,
          mimeType: head.ContentType || getMimeType(name),
          etag: head.ETag ? head.ETag.replace(/["']/g, '') : undefined,
        };
      } catch {
        // Fall through to directory checks
      }
    }

    // 2. Check if explicit folder marker object exists (${cleanKey}/)
    try {
      const headDir = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: `${cleanKey}/` })
      );
      const name = path.posix.basename(cleanKey);
      return {
        name,
        path: `/${bucket}/${cleanKey}`,
        size: 0,
        isDirectory: true,
        mtime: headDir.LastModified ? formatDate(headDir.LastModified) : undefined,
        mtimeMs: headDir.LastModified ? headDir.LastModified.getTime() : undefined,
      };
    } catch {
      // Fall through to prefix check
    }

    // 3. Check if virtual prefix exists (contains any objects or sub-prefixes)
    const list = await this.client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${cleanKey}/`,
        MaxKeys: 1,
      })
    );

    const hasChildren =
      (list.Contents && list.Contents.length > 0) ||
      (list.CommonPrefixes && list.CommonPrefixes.length > 0) ||
      Boolean(list.KeyCount && list.KeyCount > 0);

    if (hasChildren) {
      const name = path.posix.basename(cleanKey);
      return {
        name,
        path: `/${bucket}/${cleanKey}`,
        size: 0,
        isDirectory: true,
      };
    }

    throw new Error(`Path not found: ${remotePath}`);
  }

  async createFolder(remotePath: string): Promise<void> {
    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket) {
      throw new Error(`Cannot create folder at root: ${remotePath}`);
    }

    if (!key) {
      const createParams: CreateBucketCommandInput = {
        Bucket: bucket,
        ...(this.config.region && this.config.region !== 'us-east-1'
          ? {
              CreateBucketConfiguration: {
                LocationConstraint: this.config.region as BucketLocationConstraint,
              },
            }
          : {}),
      };
      await this.client.send(new CreateBucketCommand(createParams));
      this.clearCache();
      return;
    }

    const folderKey = key.endsWith('/') ? key : `${key}/`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: folderKey,
        Body: '',
        ContentLength: 0,
        ...this.sseParams(),
      })
    );
    this.clearCache();
  }

  async delete(remotePath: string, isDirectory: boolean): Promise<void> {
    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket) {
      throw new Error(`Cannot delete root: ${remotePath}`);
    }

    if (!key) {
      if (!isDirectory) {
        throw new Error(`Expected file but found bucket: ${remotePath}`);
      }
      await this.client.send(new DeleteBucketCommand({ Bucket: bucket }));
      this.clearCache();
      return;
    }

    if (!isDirectory) {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        })
      );
      this.clearCache();
      return;
    }

    // Deleting directory: delete all objects under the prefix, plus the directory marker
    const prefix = key.endsWith('/') ? key : `${key}/`;

    // Try deleting with version awareness first (permanently deletes all versions and delete markers).
    // If the endpoint does not support ListObjectVersions or permission is denied, fall back to ListObjectsV2.
    let usedVersions = false;
    try {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;

      do {
        const output = await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            Prefix: prefix,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          })
        );

        usedVersions = true;
        const objectsToDelete: { Key: string; VersionId?: string }[] = [];
        for (const v of output.Versions ?? []) {
          if (v.Key) {
            objectsToDelete.push({ Key: v.Key, VersionId: v.VersionId });
          }
        }
        for (const m of output.DeleteMarkers ?? []) {
          if (m.Key) {
            objectsToDelete.push({ Key: m.Key, VersionId: m.VersionId });
          }
        }

        if (objectsToDelete.length > 0) {
          await this.deleteObjectsBatch(bucket, objectsToDelete);
        }

        keyMarker = output.IsTruncated ? output.NextKeyMarker : undefined;
        versionIdMarker = output.IsTruncated ? output.NextVersionIdMarker : undefined;
        if (output.IsTruncated && !keyMarker && !versionIdMarker) {
          const lastV = output.Versions?.[output.Versions.length - 1];
          const lastM = output.DeleteMarkers?.[output.DeleteMarkers.length - 1];
          keyMarker = lastV?.Key ?? lastM?.Key;
        }
      } while (keyMarker || versionIdMarker);
    } catch (err: unknown) {
      if (usedVersions) {
        // If it failed while already in progress with ListObjectVersionsCommand, rethrow
        throw err;
      }
      // Fall back to ListObjectsV2Command
      let continuationToken: string | undefined = undefined;
      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });
        const listed: ListObjectsV2CommandOutput = await this.client.send(listCommand);

        const objectsToDelete: { Key: string }[] = [];
        for (const item of listed.Contents ?? []) {
          if (item.Key) {
            objectsToDelete.push({ Key: item.Key });
          }
        }

        if (objectsToDelete.length > 0) {
          await this.deleteObjectsBatch(bucket, objectsToDelete);
        }

        continuationToken = listed.NextContinuationToken;
      } while (continuationToken);
    }

    // Also ensure folder markers (both prefix with trailing slash and key without trailing slash) are deleted
    await this.client
      .send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: prefix,
        })
      )
      .catch(() => {});

    if (prefix !== key) {
      await this.client
        .send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        )
        .catch(() => {});
    }

    this.clearCache();
  }

  private async deleteObjectsBatch(
    bucket: string,
    objects: { Key: string; VersionId?: string }[]
  ): Promise<void> {
    if (objects.length === 0) return;

    // S3 DeleteObjects supports up to 1000 items per call
    const chunkSize = 1000;
    for (let i = 0; i < objects.length; i += chunkSize) {
      const chunk = objects.slice(i, i + chunkSize);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: chunk,
            Quiet: true,
          },
        })
      );

      if (res.Errors && res.Errors.length > 0) {
        const firstErr = res.Errors[0];
        throw new Error(
          `Failed to delete ${res.Errors.length} object(s) in S3: ${firstErr.Key} (${firstErr.Code ?? 'Error'}${firstErr.Message ? `: ${firstErr.Message}` : ''})`
        );
      }
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const src = parseS3Path(oldPath);
    const dst = parseS3Path(newPath);

    if (!src.bucket || !src.key) {
      throw new Error(`Cannot rename root or bucket directly: ${oldPath}`);
    }

    if (!dst.bucket || !dst.key) {
      throw new Error(`Destination must include bucket and key: ${newPath}`);
    }

    const encodedSourceKey = src.key
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const copyCommand = new CopyObjectCommand({
      Bucket: dst.bucket,
      Key: dst.key,
      CopySource: `${src.bucket}/${encodedSourceKey}`,
      ...this.sseParams(),
    });

    let copyErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.send(copyCommand);
        copyErr = null;
        break;
      } catch (err: any) {
        copyErr = err;
        const code = err?.name || err?.Code || err?.code;
        if (code === 'NoSuchKey' && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 150));
          continue;
        }
        throw err;
      }
    }
    if (copyErr) throw copyErr;

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: src.bucket,
        Key: src.key,
      })
    );
    this.clearCache();
  }

  async setMetadata(remotePath: string, metadata: ObjectMetadata): Promise<void> {
    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket || !key) {
      throw new Error(`Cannot set metadata on root or bucket: ${remotePath}`);
    }

    const encodedKey = key
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

    await this.client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: `${bucket}/${encodedKey}`,
        MetadataDirective: 'REPLACE',
        ContentType: metadata.contentType || head.ContentType || getMimeType(key),
        Metadata: head.Metadata,
        ...this.sseParams(),
      })
    );
    this.clearCache();
  }

  async createReadStream(
    remotePath: string,
    start?: number,
    end?: number,
  ): Promise<NodeJS.ReadableStream> {
    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket || !key) {
      throw new Error(`Cannot read root or bucket as stream: ${remotePath}`);
    }

    const params: GetObjectCommandInput = {
      Bucket: bucket,
      Key: key,
    };

    if (typeof start === 'number' || typeof end === 'number') {
      const startStr = typeof start === 'number' ? start : '';
      const endStr = typeof end === 'number' ? end : '';
      params.Range = `bytes=${startStr}-${endStr}`;
    }

    const res = await this.client.send(new GetObjectCommand(params));

    if (!res.Body) {
      throw new Error(`Empty response body for: ${remotePath}`);
    }

    return res.Body as NodeJS.ReadableStream;
  }

  /**
   * Generates a temporary, pre-signed HTTPS URL for downloading a single
   * object without AWS credentials. SigV4 caps the expiry at 7 days.
   */
  async getPresignedUrl(remotePath: string, expiresInSeconds: number): Promise<string> {
    const { bucket, key } = parseS3Path(remotePath);
    if (!bucket || !key) {
      throw new Error(`Requires an object path: ${remotePath}`);
    }
    const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
    const expiresIn = Math.min(Math.max(1, Math.floor(expiresInSeconds)), MAX_EXPIRY_SECONDS);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
  }

  async createWriteStream(
    remotePath: string,
    options?: WriteStreamOptions,
  ): Promise<NodeJS.WritableStream> {
    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket || !key) {
      throw new Error(`Cannot write to root or bucket: ${remotePath}`);
    }

    const passThrough = new PassThrough({ autoDestroy: false, emitClose: false });
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: passThrough,
        ContentType: getMimeType(key),
        ...(options?.size !== undefined && options.size >= 0
          ? { ContentLength: options.size }
          : {}),
        ...this.sseParams(),
      },
    });

    // Start consuming stream data immediately to avoid backpressure deadlocks
    const uploadPromise = upload.done();
    // An S3 object is only replaced when the (multipart) upload completes; an aborted one leaves the old object intact.
    let uploaded = false;
    uploadPromise
      .then(() => {
        uploaded = true;
        this.clearCache();
      })
      .catch((err) => {
        if (!passThrough.destroyed) {
          passThrough.destroy(err);
        }
      });

    const originalFinal = passThrough._final.bind(passThrough);
    passThrough._final = (callback) => {
      originalFinal(async (err) => {
        if (err) return callback(err);
        try {
          await uploadPromise;
          this.clearCache();
          callback();
          passThrough.emit('close');
        } catch (uploadErr: any) {
          callback(uploadErr);
        }
      });
    };

    passThrough.on('error', () => {
      upload.abort();
    });

    return defineTargetTouched(passThrough, () => uploaded);
  }

  async writeFile(
    remotePath: string,
    data: Buffer | Uint8Array,
    _options?: WriteStreamOptions,
  ): Promise<void> {
    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket || !key) {
      throw new Error(`Cannot write to root or bucket: ${remotePath}`);
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: getMimeType(key),
        ContentLength: data.byteLength,
        ...this.sseParams(),
      })
    );
    this.clearCache();
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const { bucket, key } = parseS3Path(remotePath);

    if (!bucket || !key) {
      throw new Error(`Cannot read root or bucket as file: ${remotePath}`);
    }

    const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

    if (!res.Body) {
      return Buffer.alloc(0);
    }

    const byteArray = await (res.Body as any).transformToByteArray();
    return Buffer.from(byteArray);
  }

  async getTags(remotePath: string): Promise<S3Tag[]> {
    const { bucket, key } = parseS3Path(remotePath);
    if (!bucket) {
      throw new Error(`Cannot get tags for the root: ${remotePath}`);
    }

    try {
      if (!key) {
        const output = await this.client.send(new GetBucketTaggingCommand({ Bucket: bucket }));
        return (output.TagSet ?? []).map((t) => ({ key: t.Key ?? '', value: t.Value ?? '' }));
      }
      const output = await this.client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key }));
      return (output.TagSet ?? []).map((t) => ({ key: t.Key ?? '', value: t.Value ?? '' }));
    } catch (err: any) {
      if (err?.name === 'NoSuchTagSet' || err?.Code === 'NoSuchTagSet') {
        return [];
      }
      throw err;
    }
  }

  async setTags(remotePath: string, tags: S3Tag[]): Promise<void> {
    const { bucket, key } = parseS3Path(remotePath);
    if (!bucket) {
      throw new Error(`Cannot set tags for the root: ${remotePath}`);
    }

    const TagSet = tags.map((t) => ({ Key: t.key, Value: t.value }));

    if (!key) {
      if (tags.length === 0) {
        await this.client.send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
        this.clearCache();
        return;
      }
      await this.client.send(new PutBucketTaggingCommand({ Bucket: bucket, Tagging: { TagSet } }));
      this.clearCache();
      return;
    }

    if (tags.length === 0) {
      await this.client.send(new DeleteObjectTaggingCommand({ Bucket: bucket, Key: key }));
      this.clearCache();
      return;
    }
    await this.client.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: key, Tagging: { TagSet } }));
    this.clearCache();
  }

  private requireBucketOnly(remotePath: string): string {
    const { bucket, key } = parseS3Path(remotePath);
    if (!bucket || key) {
      throw new Error(`Requires a bucket path: ${remotePath}`);
    }
    return bucket;
  }

  async getBucketPolicy(remotePath: string): Promise<string | null> {
    const bucket = this.requireBucketOnly(remotePath);
    try {
      const output = await this.client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
      return output.Policy ?? null;
    } catch (err: any) {
      if (err?.name === 'NoSuchBucketPolicy' || err?.Code === 'NoSuchBucketPolicy') {
        return null;
      }
      throw err;
    }
  }

  async setBucketPolicy(remotePath: string, policy: string | null): Promise<void> {
    const bucket = this.requireBucketOnly(remotePath);
    if (!policy || !policy.trim()) {
      await this.client.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
      return;
    }
    await this.client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: policy }));
  }

  async getBucketCors(remotePath: string): Promise<string | null> {
    const bucket = this.requireBucketOnly(remotePath);
    try {
      const output = await this.client.send(new GetBucketCorsCommand({ Bucket: bucket }));
      return JSON.stringify(output.CORSRules ?? [], null, 2);
    } catch (err: any) {
      if (err?.name === 'NoSuchCORSConfiguration' || err?.Code === 'NoSuchCORSConfiguration') {
        return null;
      }
      throw err;
    }
  }

  async setBucketCors(remotePath: string, corsJson: string | null): Promise<void> {
    const bucket = this.requireBucketOnly(remotePath);
    if (!corsJson || !corsJson.trim()) {
      await this.client.send(new DeleteBucketCorsCommand({ Bucket: bucket }));
      return;
    }
    let rules: unknown;
    try {
      rules = JSON.parse(corsJson);
    } catch {
      throw new Error('Invalid JSON for CORS rules');
    }
    if (!Array.isArray(rules)) {
      throw new Error('CORS rules must be a JSON array of rules');
    }
    await this.client.send(
      new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: rules as any } })
    );
  }

  async getBucketVersioning(remotePath: string): Promise<BucketVersioningInfo> {
    const bucket = this.requireBucketOnly(remotePath);
    const output = await this.client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    return { status: (output.Status as BucketVersioningInfo['status']) ?? 'Disabled' };
  }

  async setBucketVersioning(remotePath: string, enabled: boolean): Promise<void> {
    const bucket = this.requireBucketOnly(remotePath);
    await this.client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: enabled ? 'Enabled' : 'Suspended' },
      })
    );
  }

  async listObjectVersions(remotePath: string): Promise<ObjectVersionEntry[]> {
    const { bucket, key } = parseS3Path(remotePath);
    if (!bucket) {
      throw new Error(`Cannot list versions for the root: ${remotePath}`);
    }

    const results: ObjectVersionEntry[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    do {
      const output = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key || undefined,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        })
      );

      for (const v of output.Versions ?? []) {
        if (key && v.Key !== key) continue;
        results.push({
          versionId: v.VersionId ?? '',
          isLatest: Boolean(v.IsLatest),
          isDeleteMarker: false,
          size: v.Size ?? 0,
          lastModified: v.LastModified ? formatDate(v.LastModified) : undefined,
        });
      }

      for (const m of output.DeleteMarkers ?? []) {
        if (key && m.Key !== key) continue;
        results.push({
          versionId: m.VersionId ?? '',
          isLatest: Boolean(m.IsLatest),
          isDeleteMarker: true,
          size: 0,
          lastModified: m.LastModified ? formatDate(m.LastModified) : undefined,
        });
      }

      keyMarker = output.IsTruncated ? output.NextKeyMarker : undefined;
      versionIdMarker = output.IsTruncated ? output.NextVersionIdMarker : undefined;
    } while (keyMarker);

    results.sort((a, b) => (a.lastModified ?? '') < (b.lastModified ?? '') ? 1 : -1);
    return results;
  }

  async deleteObjectVersion(remotePath: string, versionId: string): Promise<void> {
    const { bucket, key } = parseS3Path(remotePath);
    if (!bucket || !key) {
      throw new Error(`Requires an object path: ${remotePath}`);
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
    this.clearCache();
  }

  async restoreObjectVersion(remotePath: string, versionId: string): Promise<void> {
    const { bucket, key } = parseS3Path(remotePath);
    if (!bucket || !key) {
      throw new Error(`Requires an object path: ${remotePath}`);
    }
    const encodedKey = key
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    await this.client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        Key: key,
        CopySource: `${bucket}/${encodedKey}?versionId=${versionId}`,
        ...this.sseParams(),
      })
    );
    this.clearCache();
  }

  /**
   * Retrieves an S3 object's checksum or ETag (MD5 for single-part objects).
   */
  async getChecksum(remotePath: string, algorithm: 'sha256' | 'md5' = 'sha256'): Promise<string | undefined> {
    const { bucket, key } = parseS3Path(remotePath);
    if (!bucket || !key) return undefined;
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key.replace(/\/+$/, '') })
      );
      if (algorithm === 'sha256' && head.ChecksumSHA256) {
        return Buffer.from(head.ChecksumSHA256, 'base64').toString('hex');
      }
      if (head.ETag) {
        const clean = head.ETag.replace(/["']/g, '');
        if (algorithm === 'md5' && /^[0-9a-f]{32}$/i.test(clean)) {
          return clean;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }
}
