import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DemoStorageProvider } from '../../src/main/demo/DemoStorageProvider';
import type { FileEntry, IStorageProvider } from '../../src/shared/types/storage';

/**
 * The demo workspace's in-memory file system (src/main/demo/DemoStorageProvider.ts): what StorageRegistry
 * hands out for a demo target instead of a real SFTP server or S3 bucket, so browsing, editing, uploading
 * and downloading on a demo target behaves like a real provider without any connection.
 */

/** A demo server's SFTP side, built the way StorageRegistry builds it for a demo target. */
function demoServer(hostOrBucket = 'netapp-aff-a800-01a'): DemoStorageProvider {
  return new DemoStorageProvider({
    id: 'sftp-demo-netapp-aff-a800-01a',
    name: 'netapp-aff-a800-01a',
    type: 'sftp',
    hostOrBucket,
  });
}

/** A demo S3 profile's bucket. */
function demoBucket(): DemoStorageProvider {
  return new DemoStorageProvider({
    id: 's3-demo-s3-storagegrid-prod',
    name: 'StorageGRID Prod',
    type: 's3',
    hostOrBucket: 'StorageGRID Prod',
  });
}

const names = (entries: FileEntry[]): string[] => entries.map((entry) => entry.name);

async function readText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

describe('DemoStorageProvider', () => {
  it('is a storage provider carrying the identity of the demo target it stands in for', () => {
    const server: IStorageProvider = demoServer();
    expect({ id: server.id, name: server.name, type: server.type }).toEqual({
      id: 'sftp-demo-netapp-aff-a800-01a',
      name: 'netapp-aff-a800-01a',
      type: 'sftp',
    });
    expect(demoBucket().type).toBe('s3');
  });

  describe('list', () => {
    it("lists a folder's direct children, folders first and then by name", async () => {
      const server = demoServer();
      expect(names(await server.list('/'))).toEqual(['etc', 'root', 'var']);
      expect((await server.list('/etc')).map((entry) => [entry.name, entry.path, entry.isDirectory])).toEqual([
        ['ceph', '/etc/ceph', true],
        ['trident', '/etc/trident', true],
        ['multipath.conf', '/etc/multipath.conf', false],
      ]);
      expect(names(await server.list('/etc/trident'))).toEqual([
        'backend-ontap-nas-flexgroup.json',
        'storageclass-ontap-flexgroup-ai.yaml',
      ]);
    });

    it('accepts the path forms a file manager sends: relative, trailing or repeated slashes, backslashes', async () => {
      const server = demoServer();
      const etc = await server.list('/etc');
      for (const form of ['etc', '/etc/', '//etc//', '\\etc']) {
        expect(await server.list(form), form).toEqual(etc);
      }
      const root = await server.list('/');
      expect(await server.list('')).toEqual(root);
      expect(await server.list('.')).toEqual(root);
    });

    it('seeds a demo bucket with a bucket layout of its own', async () => {
      const bucket = demoBucket();
      expect(names(await bucket.list('/'))).toEqual(['llm-checkpoints-prod', 'ontap-fabricpool-tier', 'veeam-immutable-vault']);
      expect(names(await bucket.list('/ontap-fabricpool-tier'))).toEqual(['fabricpool-metadata', 'runbooks']);
      await expect(bucket.stat('/etc')).rejects.toThrow(/ENOENT/);
      expect(await bucket.getHomeDir()).toBe('/');
      expect(await demoServer().getHomeDir()).toBe('/etc');
    });
  });

  describe('stat and read', () => {
    it('reports files and folders, and ENOENT for a path that does not exist', async () => {
      const server = demoServer();
      const conf = await server.stat('/etc/ceph/ceph.conf');
      expect(conf).toMatchObject({
        name: 'ceph.conf',
        path: '/etc/ceph/ceph.conf',
        isDirectory: false,
        permissions: '-rw-r--r--',
      });
      expect(conf.size).toBe((await server.readFile('/etc/ceph/ceph.conf')).length);
      expect(conf.mtime).toBe(new Date(conf.mtimeMs as number).toISOString());
      expect(await server.stat('/etc/ceph')).toMatchObject({
        name: 'ceph',
        isDirectory: true,
        size: 4096,
        permissions: 'drwxr-xr-x',
      });
      expect((await server.stat('/root/runbooks/ontap-latency-remediation.sh')).permissions).toBe('-rwxr-xr-x');
      await expect(server.stat('/etc/does-not-exist.conf')).rejects.toThrow(/ENOENT/);
    });

    it('serves the seeded sample files, chosen by the host they stand in for', async () => {
      const storageNode = (await demoServer().readFile('/etc/multipath.conf')).toString('utf8');
      expect(storageNode).toContain('path_grouping_policy group_by_prio');
      const worker = (await demoServer('k8s-worker-01').readFile('/etc/multipath.conf')).toString('utf8');
      expect(worker).toContain('path_grouping_policy multibus');

      const tier = JSON.parse(
        (await demoBucket().readFile('/ontap-fabricpool-tier/fabricpool-metadata/aggr1_nvme_prod_tier.json')).toString('utf8')
      );
      expect(tier).toMatchObject({ aggregate: 'aggr1_nvme_prod', coolingDays: 14 });
    });

    it('refuses to read a folder or a missing file', async () => {
      const server = demoServer();
      await expect(server.readFile('/etc/ceph')).rejects.toThrow(/ENOENT/);
      await expect(server.readFile('/etc/missing.conf')).rejects.toThrow(/ENOENT/);
    });

    it('streams a file whole or from a byte range, the end byte included', async () => {
      const server = demoServer();
      const file = '/etc/ceph/ceph.conf';
      const whole = (await server.readFile(file)).toString('utf8');
      expect(whole.startsWith('[global]\nfsid = ')).toBe(true);

      expect(await readText(await server.createReadStream(file))).toBe(whole);
      expect(await readText(await server.createReadStream(file, 0, 7))).toBe('[global]');
      expect(await readText(await server.createReadStream(file, undefined, 7))).toBe('[global]');
      expect(await readText(await server.createReadStream(file, 9))).toBe(whole.slice(9));
      await expect(server.createReadStream('/etc/missing.conf')).rejects.toThrow(/ENOENT/);
    });

    it('checksums the content like any other provider', async () => {
      const server = demoServer();
      const data = await server.readFile('/var/log/syslog');
      expect(await server.getChecksum('/var/log/syslog')).toBe(crypto.createHash('sha256').update(data).digest('hex'));
      expect(await server.getChecksum('/var/log/syslog', 'md5')).toBe(crypto.createHash('md5').update(data).digest('hex'));
    });
  });

  describe('write', () => {
    it('writes a file, creating the folders above it, and reads it back', async () => {
      const server = demoServer();
      await server.writeFile('/srv/app/config/app.env', Buffer.from('MODE=demo\n'));
      expect((await server.readFile('/srv/app/config/app.env')).toString('utf8')).toBe('MODE=demo\n');
      expect((await server.stat('/srv/app/config/app.env')).size).toBe(10);
      expect(names(await server.list('/'))).toEqual(['etc', 'root', 'srv', 'var']);
      expect(await server.list('/srv/app')).toMatchObject([{ name: 'config', path: '/srv/app/config', isDirectory: true }]);

      // Writing again replaces the content; a Uint8Array works like a Buffer.
      await server.writeFile('/srv/app/config/app.env', new TextEncoder().encode('MODE=live\n'));
      expect((await server.readFile('/srv/app/config/app.env')).toString('utf8')).toBe('MODE=live\n');
      expect(names(await server.list('/srv/app/config'))).toEqual(['app.env']);
    });

    it('stores what is piped into a write stream as one file once the stream ends', async () => {
      const server = demoServer();
      await pipeline(Readable.from(['line 1\n', 'line 2\n']), await server.createWriteStream('/tmp/upload/report.txt'));
      expect((await server.readFile('/tmp/upload/report.txt')).toString('utf8')).toBe('line 1\nline 2\n');
      expect(names(await server.list('/tmp/upload'))).toEqual(['report.txt']);
    });

    it('does not store a write stream that has not ended yet', async () => {
      const server = demoServer();
      const stream = await server.createWriteStream('/tmp/partial.txt');
      await new Promise<void>((resolve, reject) => stream.write('half', (err) => (err ? reject(err) : resolve())));
      await expect(server.stat('/tmp/partial.txt')).rejects.toThrow(/ENOENT/);

      await new Promise<void>((resolve) => stream.end(' and the rest', () => resolve()));
      expect((await server.readFile('/tmp/partial.txt')).toString('utf8')).toBe('half and the rest');
    });
  });

  describe('folders, rename and delete', () => {
    it('creates nested folders', async () => {
      const server = demoServer();
      await server.createFolder('/data/reports/2026');
      expect(await server.list('/data')).toMatchObject([{ name: 'reports', isDirectory: true }]);
      expect(await server.list('/data/reports')).toMatchObject([{ name: '2026', path: '/data/reports/2026', isDirectory: true }]);
      expect(await server.list('/data/reports/2026')).toEqual([]);
    });

    it('renames a file, and refuses to rename a missing one', async () => {
      const server = demoServer();
      await server.writeFile('/data/q1.txt', Buffer.from('q1'));
      await server.rename('/data/q1.txt', '/data/q1-final.txt');
      expect(names(await server.list('/data'))).toEqual(['q1-final.txt']);
      expect((await server.readFile('/data/q1-final.txt')).toString('utf8')).toBe('q1');
      await expect(server.stat('/data/q1.txt')).rejects.toThrow(/ENOENT/);
      await expect(server.rename('/data/missing.txt', '/data/other.txt')).rejects.toThrow(/ENOENT/);
    });

    it('deletes a file, or a folder with everything in it but not a sibling whose name starts the same', async () => {
      const server = demoServer();
      await server.writeFile('/data/reports/2026/q1.txt', Buffer.from('q1'));
      await server.createFolder('/data/rep');

      await server.delete('/data/reports');
      expect(names(await server.list('/data'))).toEqual(['rep']);
      await expect(server.stat('/data/reports/2026/q1.txt')).rejects.toThrow(/ENOENT/);
      await expect(server.stat('/data/reports')).rejects.toThrow(/ENOENT/);

      await server.delete('/etc/multipath.conf');
      expect(names(await server.list('/etc'))).toEqual(['ceph', 'trident']);
    });
  });

  it('keeps the files of every demo target to itself', async () => {
    const first = demoServer();
    const second = demoServer();
    await first.writeFile('/tmp/only-in-first.txt', Buffer.from('first'));
    await first.delete('/etc/ceph');
    await expect(second.stat('/tmp/only-in-first.txt')).rejects.toThrow(/ENOENT/);
    expect(names(await second.list('/etc'))).toEqual(['ceph', 'trident', 'multipath.conf']);
  });

  it('reports free space, and disconnects without anything to close', async () => {
    const server = demoServer();
    const space = await server.getSpace();
    expect(space).toEqual({ totalBytes: expect.any(Number), freeBytes: expect.any(Number) });
    expect(space !== undefined && space.freeBytes < space.totalBytes).toBe(true);
    await expect(server.disconnect()).resolves.toBeUndefined();
  });
});
