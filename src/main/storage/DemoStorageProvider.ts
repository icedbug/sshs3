import { Readable, Writable } from 'node:stream';
import crypto from 'node:crypto';
import type {
  FileEntry,
  IStorageProvider,
  SpaceInfo,
  StorageType,
  WriteStreamOptions,
} from '../../shared/types/storage';

interface VirtualFileNode {
  path: string;
  name: string;
  isDirectory: boolean;
  content?: string;
  mtimeMs: number;
  permissions: string;
}

export class DemoStorageProvider implements IStorageProvider {
  public readonly id: string;
  public readonly name: string;
  public readonly type: StorageType;
  private nodes = new Map<string, VirtualFileNode>();

  constructor(params: { id: string; name: string; type: StorageType; hostOrBucket?: string }) {
    this.id = params.id;
    this.name = params.name;
    this.type = params.type;
    this.seedFilesystem(params.hostOrBucket || params.name);
  }

  private normalize(p: string): string {
    if (!p || p === '.') return '/';
    const cleaned = ('/' + p.replace(/\\/g, '/')).replace(/\/+/g, '/');
    return cleaned.length > 1 && cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;
  }

  private addDir(dirPath: string): void {
    const norm = this.normalize(dirPath);
    const parts = norm.split('/').filter(Boolean);
    let curr = '';
    for (const part of parts) {
      curr += '/' + part;
      if (!this.nodes.has(curr)) {
        this.nodes.set(curr, {
          path: curr,
          name: part,
          isDirectory: true,
          mtimeMs: Date.now() - 3600_000,
          permissions: 'drwxr-xr-x',
        });
      }
    }
  }

  private addFile(filePath: string, content: string, permissions = '-rw-r--r--'): void {
    const norm = this.normalize(filePath);
    const lastSlash = norm.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : norm.slice(0, lastSlash);
    const name = norm.slice(lastSlash + 1);
    if (parent !== '/') this.addDir(parent);
    this.nodes.set(norm, {
      path: norm,
      name,
      isDirectory: false,
      content,
      mtimeMs: Date.now() - 1800_000,
      permissions,
    });
  }

  private seedFilesystem(hint: string): void {
    const h = hint.toLowerCase();
    this.nodes.set('/', {
      path: '/',
      name: '/',
      isDirectory: true,
      mtimeMs: Date.now() - 86400_000,
      permissions: 'drwxr-xr-x',
    });

    if (this.type === 's3') {
      this.addFile(
        '/ontap-fabricpool-tier/runbooks/ontap-9.15-operations-handbook.md',
        '# NetApp ONTAP 9.15 Operations Handbook\n\n- QoS Policy: pg-prod-db-extreme (min 10k IOPS, max 120k IOPS)\n- Batch Throttling: pg-batch-ceiling (max 15k IOPS)\n'
      );
      this.addFile(
        '/ontap-fabricpool-tier/runbooks/storagegrid-ilm-guide.md',
        '# NetApp StorageGRID 11.8 ILM Policy Guide\n\nActive Policy: ILM-Prod-FabricPool-EC63 (Erasure Coding 6+3 across Stockholm DC1 & Uppsala DC2)\n'
      );
      this.addFile(
        '/ontap-fabricpool-tier/fabricpool-metadata/aggr1_nvme_prod_tier.json',
        JSON.stringify(
          {
            cluster: 'NetApp-ONTAP-Prod-SE',
            aggregate: 'aggr1_nvme_prod',
            tieredBytes: 52776558133248,
            coolingDays: 14,
            objectLock: 'COMPLIANCE',
          },
          null,
          2
        )
      );
      this.addFile(
        '/llm-checkpoints-prod/llama4-70b-finetune/checkpoint-step-12000.json',
        JSON.stringify({ step: 12000, loss: 0.8412, storageClass: 'ontap-flexgroup-ai' }, null, 2)
      );
      this.addFile(
        '/veeam-immutable-vault/pgbackrest/prod-db-backup-manifest.json',
        JSON.stringify({ database: 'prod-pg-01', wormRetentionDays: 90, verified: true }, null, 2)
      );
      return;
    }

    const isWorker = h.includes('worker');
    this.addFile(
      '/etc/multipath.conf',
      [
        '# /etc/multipath.conf — NetApp ONTAP SAN LUN Configuration',
        'defaults {',
        '    user_friendly_names yes',
        '    find_multipaths yes',
        '}',
        'devices {',
        '    device {',
        '        vendor "NETAPP"',
        '        product "LUN.*"',
        `        path_grouping_policy ${isWorker ? 'multibus' : 'group_by_prio'}`,
        '        path_checker tur',
        '        features "2 pg_init_retries 50"',
        '        hardware_handler "1 alua"',
        '        prio alua',
        '        failback immediate',
        '        rr_min_io_rq 1',
        '    }',
        '}',
      ].join('\n')
    );

    this.addFile(
      '/etc/ceph/ceph.conf',
      [
        '[global]',
        'fsid = 9b4e7c12-84d0-4f19-a910-55b019283746',
        'mon_initial_members = ceph-mon-mgr-01, ceph-mon-02, ceph-mon-03',
        'mon_host = 10.30.40.10,10.30.40.11,10.30.40.12',
        'public_network = 10.30.40.0/24',
        'cluster_network = 10.30.140.0/24',
        'osd_pool_default_size = 3',
        'osd_pool_default_min_size = 2',
        'osd_max_backfills = 2',
      ].join('\n')
    );

    this.addFile(
      '/etc/trident/backend-ontap-nas-flexgroup.json',
      JSON.stringify(
        {
          version: 1,
          storageDriverName: 'ontap-nas-flexgroup',
          backendName: 'tbc-ontap-nas-flexgroup-ai',
          managementLIF: '10.30.10.11',
          dataLIF: '10.30.10.55',
          svm: 'svm-prod-nfs',
          autoExportPolicy: true,
          autoExportCIDRs: ['10.30.50.0/24'],
        },
        null,
        2
      )
    );

    this.addFile(
      '/etc/trident/storageclass-ontap-flexgroup-ai.yaml',
      [
        'apiVersion: storage.k8s.io/v1',
        'kind: StorageClass',
        'metadata:',
        '  name: ontap-flexgroup-ai',
        'provisioner: csi.trident.netapp.io',
        'parameters:',
        '  backendType: "ontap-nas-flexgroup"',
        'mountOptions:',
        '  - nfsvers=4.1',
        '  - nconnect=8',
        '  - noatime',
      ].join('\n')
    );

    this.addFile(
      '/var/log/syslog',
      [
        'Oct 31 17:15:02 node kernel: [14210.412] multipathd: 3600a0980383146525a2b516a4b38724d: path_grouping_policy active',
        'Oct 31 17:20:19 node trident_acp[2190]: time="2026-10-31T17:20:19Z" level=info msg="ONTAP backend tbc-ontap-nas-premium online"',
        'Oct 31 17:24:41 node systemd[1]: Started NetApp Harvest Telemetry Exporter.',
      ].join('\n')
    );

    this.addFile(
      '/root/runbooks/ontap-latency-remediation.sh',
      [
        '#!/usr/bin/env bash',
        '# Diagnose and throttle noisy neighbor volumes on NetApp AFF A800',
        'ssh admin@10.30.10.12 "qos statistics volume latency show -iterations 3"',
        'ssh admin@10.30.10.12 "volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling"',
      ].join('\n'),
      '-rwxr-xr-x'
    );
  }

  private toEntry(node: VirtualFileNode): FileEntry {
    const size = node.isDirectory ? 4096 : Buffer.byteLength(node.content ?? '', 'utf8');
    return {
      name: node.name,
      path: node.path,
      size,
      isDirectory: node.isDirectory,
      mtime: new Date(node.mtimeMs).toISOString(),
      mtimeMs: node.mtimeMs,
      permissions: node.permissions,
    };
  }

  public async list(remotePath: string): Promise<FileEntry[]> {
    const dir = this.normalize(remotePath);
    const prefix = dir === '/' ? '/' : dir + '/';
    const entries: FileEntry[] = [];
    for (const [p, node] of this.nodes.entries()) {
      if (p === '/' || p === dir) continue;
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        if (!rest.includes('/')) {
          entries.push(this.toEntry(node));
        }
      }
    }
    return entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  public async stat(remotePath: string): Promise<FileEntry> {
    const norm = this.normalize(remotePath);
    const node = this.nodes.get(norm);
    if (!node) {
      throw new Error(`ENOENT: no such file or directory, stat '${norm}'`);
    }
    return this.toEntry(node);
  }

  public async createFolder(remotePath: string): Promise<void> {
    this.addDir(remotePath);
  }

  public async delete(remotePath: string): Promise<void> {
    const norm = this.normalize(remotePath);
    for (const key of Array.from(this.nodes.keys())) {
      if (key === norm || key.startsWith(norm + '/')) {
        this.nodes.delete(key);
      }
    }
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const oldNorm = this.normalize(oldPath);
    const newNorm = this.normalize(newPath);
    const node = this.nodes.get(oldNorm);
    if (!node) throw new Error(`ENOENT: '${oldNorm}'`);
    this.nodes.delete(oldNorm);
    const lastSlash = newNorm.lastIndexOf('/');
    this.nodes.set(newNorm, {
      ...node,
      path: newNorm,
      name: newNorm.slice(lastSlash + 1),
      mtimeMs: Date.now(),
    });
  }

  public async readFile(remotePath: string): Promise<Buffer> {
    const norm = this.normalize(remotePath);
    const node = this.nodes.get(norm);
    if (!node || node.isDirectory) {
      throw new Error(`ENOENT: no such file '${norm}'`);
    }
    return Buffer.from(node.content ?? '', 'utf8');
  }

  public async writeFile(
    remotePath: string,
    data: Buffer | Uint8Array,
    _options?: WriteStreamOptions
  ): Promise<void> {
    this.addFile(remotePath, Buffer.from(data).toString('utf8'));
  }

  public async createReadStream(
    remotePath: string,
    start?: number,
    end?: number
  ): Promise<NodeJS.ReadableStream> {
    const buf = await this.readFile(remotePath);
    const sliced =
      start !== undefined || end !== undefined
        ? buf.subarray(start ?? 0, end !== undefined ? end + 1 : buf.length)
        : buf;
    return Readable.from(sliced);
  }

  public async createWriteStream(
    remotePath: string,
    _options?: WriteStreamOptions
  ): Promise<NodeJS.WritableStream> {
    const chunks: Buffer[] = [];
    const self = this;
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
      final(callback) {
        self.addFile(remotePath, Buffer.concat(chunks).toString('utf8'));
        callback();
      },
    });
  }

  public async getChecksum(
    remotePath: string,
    algorithm: 'sha256' | 'md5' = 'sha256'
  ): Promise<string | undefined> {
    const buf = await this.readFile(remotePath);
    return crypto.createHash(algorithm).update(buf).digest('hex');
  }

  public async getHomeDir(): Promise<string> {
    return this.type === 's3' ? '/' : '/etc';
  }

  public async getSpace(): Promise<SpaceInfo | undefined> {
    return {
      totalBytes: 220 * 1024 * 1024 * 1024 * 1024,
      freeBytes: 61 * 1024 * 1024 * 1024 * 1024,
    };
  }

  public async disconnect(): Promise<void> {}
}
