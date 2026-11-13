import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

// What the demo appliances remember of the user's fixes (QoS ceiling applied, SnapMirror resynced, ...)
// is module state shared by every demo terminal of the process: each test loads a fresh copy.
let demo: typeof import('../../src/main/demo/DemoVirtualPty');

beforeEach(async () => {
  vi.resetModules();
  demo = await import('../../src/main/demo/DemoVirtualPty');
  // The welcome banner is scheduled with setTimeout: the tests decide when it is due.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** A demo fixture's connection details, as in ai/hub/demoWorkspace.ts. */
function server(name: string, host: string, extra: Partial<SSHConnectionConfig> = {}): SSHConnectionConfig {
  return { id: `demo-${name}`, name, host, port: 22, username: 'admin', authType: 'agent', ...extra };
}

const ONTAP = server('netapp-aff-a800-01a', '10.30.10.11', { cluster: 'NetApp-ONTAP-Prod-SE' });
const ONTAP_PARTNER = server('netapp-aff-a800-01b', '10.30.10.12', { cluster: 'NetApp-ONTAP-Prod-SE' });
const ONTAP_DR = server('netapp-fas9000-dr-01', '10.30.20.11');
const STORAGEGRID = server('sg-admin-primary-01', '10.30.30.10');
const MINIO = server('minio-aistor-edge-01', '10.30.30.40', { username: 'ubuntu' });
const CEPH = server('ceph-mon-mgr-01', '10.30.40.10', { username: 'cephadm' });
const TRUENAS = server('truenas-zfs-vault-01', '10.30.40.50', { username: 'truenas_admin' });
const K8S_CONTROL_PLANE = server('k8s-storage-cp-01', '10.30.50.10', { username: 'ubuntu' });
const K8S_WORKER = server('k8s-gpu-io-worker-01', '10.30.50.21', {
  username: 'ubuntu',
  cluster: 'K8s-Trident-CSI-Prod',
});

const ONTAP_PROMPT = '\x1b[1;36mNetApp-ONTAP-Prod-SE::>\x1b[0m ';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
/** One character erased on screen: back, blank, back. */
const ERASE = '\b \b';
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ARROW_RIGHT = '\x1b[C';
const ARROW_LEFT = '\x1b[D';

/** The OSC 133 "command finished" mark that TerminalRegistry reads a command's exit code from. */
const commandDone = (exitCode: number) => `\x1b]133;D;${exitCode}\x07`;

// eslint-disable-next-line no-control-regex -- removing the terminal's escape sequences is the point
const ESCAPE_SEQUENCES = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
/** `text` as the user reads it: without colours, screen control and shell-integration marks. */
const plain = (text: string) => text.replace(ESCAPE_SEQUENCES, '');

/** The line of `output` that starts with `start` (indentation ignored), trimmed. */
function line(output: string, start: string): string {
  const found = output
    .split('\r\n')
    .map((text) => text.trim())
    .find((text) => text.startsWith(start));
  if (found === undefined) throw new Error(`No line starts with "${start}" in:\n${output}`);
  return found;
}

/** The cells of a table row. */
const cells = (row: string) => row.split(/\s+/);

const run = (hostOrName: string, cmd: string) => demo.executeDemoServerCommand(hostOrName, cmd);

/** A demo terminal for `config` that has shown its welcome banner, recording what it prints and its exit. */
function open(config: SSHConnectionConfig) {
  const pty = new demo.DemoVirtualPty(config);
  const chunks: string[] = [];
  const exits: Array<{ exitCode: number; signal?: number }> = [];
  pty.onData((data) => {
    chunks.push(data);
  });
  pty.onExit((event) => {
    exits.push(event);
  });
  vi.advanceTimersByTime(30);
  const banner = chunks.splice(0).join('');
  return {
    pty,
    banner,
    /** The prompt, colours included: what follows the banner's last line. */
    prompt: banner.slice(banner.lastIndexOf('\r\n') + 2),
    exits,
    /** What the terminal printed since the last look. */
    printed: () => chunks.splice(0).join(''),
    /** Types `keys` and returns what the terminal printed in response. */
    send: (keys: string) => {
      pty.write(keys);
      return chunks.splice(0).join('');
    },
  };
}

describe('executeDemoServerCommand', () => {
  it('answers a blank line with nothing', () => {
    expect(run(ONTAP.name, '')).toEqual({ output: '', exitCode: 0 });
    expect(run(ONTAP.name, '  \t ')).toEqual({ output: '', exitCode: 0 });
  });

  it.each(['netapp-aff-a800-01a', 'aff-a400-lab', 'fas9000-dr', '10.30.10.11', '10.30.10.12', '10.30.20.11'])(
    'lists the ONTAP CLI commands on %s, an ONTAP system by name or address',
    (hostOrName) => {
      const help = run(hostOrName, 'help');
      expect(help.exitCode).toBe(0);
      expect(help.output).toContain('NetApp ONTAP 9.15.1 Interactive Demo CLI');
      expect(help.output).toContain('snapmirror resync');
      expect(run(hostOrName, '?')).toEqual(help);
      expect(run(hostOrName, '  HELP ')).toEqual(help);
    },
  );

  it.each(['k8s-gpu-io-worker-01', 'sg-admin-primary-01', 'ceph-mon-mgr-01', 'ontap-aiq-um-01', '10.30.10.25'])(
    'lists the generic appliance commands on %s, naming it',
    (hostOrName) => {
      const help = run(hostOrName, 'help');
      expect(help.exitCode).toBe(0);
      expect(help.output).toContain(`sshs3 Interactive Demo Appliance (${hostOrName})`);
      expect(help.output).toContain('kubectl get pods,pvc -A -o wide');
      expect(help.output).not.toContain('NetApp ONTAP 9.15.1 Interactive Demo CLI');
    },
  );

  it('fails a SnapMirror transfer on ONTAP when asked to simulate an error', () => {
    const failure = run(ONTAP.name, 'simulate-error');
    expect(failure.exitCode).toBe(1);
    expect(failure.output).toContain(
      'SnapMirror transfer for destination "svm-dr-uppsala:vol_ai_checkpoints_dr" aborted.',
    );
    expect(failure.output).toContain('snapmirror resync -destination-path svm-dr-uppsala:vol_ai_checkpoints_dr');
    expect(run(ONTAP.name, 'TEST-ERROR')).toEqual(failure);
  });

  it.each([
    'simulate-error',
    'test-error',
    'sudo mount /mnt/pvc-scratch',
    'kubectl describe pvc pvc-llm-checkpoints-02 -n ai-training',
  ])('fails a CSI volume mount on the other appliances: %s', (cmd) => {
    const failure = run(K8S_WORKER.name, cmd);
    expect(failure.exitCode).toBe(32);
    expect(failure.output).toContain('MountVolume.SetUp failed for volume "pvc-8f92a1b0"');
    expect(failure.output).toContain('export-policy rule missing for subnet 10.30.50.0/24');
  });

  it('shows the ONTAP cluster: aggregates, volumes, the HA pair and per-volume performance', () => {
    const aggregates = run(ONTAP.name, 'storage aggregate show');
    expect(aggregates.exitCode).toBe(0);
    expect(cells(line(aggregates.output, 'aggr1_nvme_prod')).slice(0, 4)).toEqual([
      'aggr1_nvme_prod',
      '220TB',
      '61.6TB',
      '72%',
    ]);
    expect(aggregates.output.endsWith('4 entries were displayed.')).toBe(true);

    const volumes = run(ONTAP.name, 'volume show');
    expect(volumes.exitCode).toBe(0);
    expect(cells(line(volumes.output, 'svm-prod-iscsi'))).toEqual([
      'svm-prod-iscsi',
      'vol_pg_prod_db01',
      'aggr2_nvme_db',
      'online',
      'RW',
      '12.0TB',
      '4.68TB',
      '61%',
      'snapshot-only',
    ]);
    expect(volumes.output.endsWith('5 entries were displayed.')).toBe(true);
    expect(run(ONTAP.name, 'VOLUME SHOW')).toEqual(volumes);

    const failover = run(ONTAP.name, 'storage failover show');
    expect(failover.exitCode).toBe(0);
    expect(failover.output).toContain('Connected to netapp-aff-a800-01b (NVMe-oF HA Sync OK)');
    expect(failover.output).toContain('Connected to netapp-aff-a800-01a (NVMe-oF HA Sync OK)');

    const performance = run(ONTAP.name, 'qos statistics volume performance show');
    expect(performance.exitCode).toBe(0);
    expect(cells(line(performance.output, 'vol_pg_prod_db01'))).toEqual([
      'vol_pg_prod_db01',
      '4109',
      '28400',
      '312.4MB/s',
      'pg-prod-db-extreme',
    ]);
  });

  it('shows the StorageGRID grid and its S3 buckets', () => {
    for (const cmd of ['storagegrid-status', 'storagegrid-cli health']) {
      const grid = run(STORAGEGRID.name, cmd);
      expect(grid.exitCode).toBe(0);
      expect(grid.output).toContain('Grid Status: HEALTHY (Multi-Site EC 6+3)');
      expect(cells(line(grid.output, 'minio-aistor-edge-01'))).toContain('18,400');
    }

    const buckets = run(STORAGEGRID.name, 'aws s3 ls --profile demo');
    expect(buckets.exitCode).toBe(0);
    expect(buckets.output.split('\r\n').map((row) => cells(row)[2])).toEqual([
      'ontap-fabricpool-tier',
      'llm-checkpoints-prod',
      'veeam-immutable-vault',
      'sshs3-team-workspace',
    ]);
  });

  it.each(['ceph -s', 'ceph status', 'ceph health detail', 'sudo ceph -s', 'sudo ceph status'])(
    'shows the Ceph cluster status for %s',
    (cmd) => {
      const status = run(CEPH.name, cmd);
      expect(status.exitCode).toBe(0);
      expect(line(status.output, 'health:')).toBe(
        'health: HEALTH_WARN (2 pgs not deep-scrubbed in time; 1 slow ops on osd.4)',
      );
      expect(line(status.output, 'osd:')).toBe('osd: 32 osds: 32 up (since 42d), 32 in (since 42d); 100GbE RoCEv2');
    },
  );

  it.each(['ceph osd df tree', 'sudo ceph osd df'])('shows the Ceph OSD tree for %s', (cmd) => {
    const tree = run(CEPH.name, cmd);
    expect(tree.exitCode).toBe(0);
    expect(tree.output).toContain('host ceph-osd-nvme-01');
    expect(tree.output).toContain('osd.4');
    expect(tree.output).not.toContain('health:');
  });

  it.each(['zpool status -v', 'zfs list'])('shows the TrueNAS backup pool for %s', (cmd) => {
    const pool = run(TRUENAS.name, cmd);
    expect(pool.exitCode).toBe(0);
    expect(line(pool.output, 'pool:')).toBe('pool: tank_backup_01');
    expect(line(pool.output, 'raidz3-0')).toContain('ONLINE');
    expect(pool.output).toContain('/mnt/tank_backup_01/veeam');
  });

  it('lists the Kubernetes volumes and pods, and the Trident backends', () => {
    const pods = run(K8S_WORKER.name, 'kubectl get pods,pvc -A -o wide');
    expect(pods.exitCode).toBe(0);
    expect(cells(line(pods.output, 'prod-db'))).toEqual([
      'prod-db',
      'data-postgresql-ha-0',
      'Bound',
      'pvc-4401b2d9-ontap-san',
      '12Ti',
      'RWO',
      'ontap-san-nvme',
      '94d',
    ]);
    expect(pods.output).toContain('trident-controller-67d9b8f9c-x8k2p');

    const backends = run(K8S_WORKER.name, 'tridentctl get backend -n trident');
    expect(backends.exitCode).toBe(0);
    const names = backends.output
      .split('\r\n')
      .filter((row) => row.startsWith('| tbc-'))
      .map((row) => row.split('|')[1].trim());
    expect(names).toEqual(['tbc-ontap-nas-premium', 'tbc-ontap-nas-flexgroup-ai', 'tbc-ontap-san-nvme-iscsi']);
  });

  it('flags the non-ALUA multipath policy on the GPU worker only', () => {
    expect(line(run(K8S_WORKER.name, 'multipath -ll').output, 'policy:')).toBe(
      'policy: multibus (WARNING: Non-ALUA policy! Should be group_by_prio)',
    );
    expect(line(run(K8S_WORKER.name, 'cat /etc/multipath.conf').output, 'path_grouping_policy')).toBe(
      'path_grouping_policy multibus',
    );

    expect(line(run(K8S_CONTROL_PLANE.name, 'multipath -ll').output, 'policy:')).toBe(
      'policy: group_by_prio (ALUA Active/Optimized)',
    );
    const conf = run(K8S_CONTROL_PLANE.name, 'cat /etc/multipath.conf');
    expect(conf.exitCode).toBe(0);
    expect(line(conf.output, 'path_grouping_policy')).toBe('path_grouping_policy group_by_prio');
    expect(line(conf.output, 'vendor')).toBe('vendor "NETAPP"');
  });

  it.each([
    { personality: 'StorageGRID node', hostOrName: 'sg-sn-nvme-01', mount: '/dev/mapper/sg-rangedb-nvme01' },
    { personality: 'StorageGRID node by address', hostOrName: '10.30.30.21', mount: '/dev/mapper/sg-rangedb-nvme01' },
    { personality: 'MinIO edge cache', hostOrName: 'minio-aistor-edge-01', mount: '/dev/mapper/sg-rangedb-nvme01' },
    { personality: 'TrueNAS vault', hostOrName: 'truenas-zfs-vault-01', mount: 'tank_backup_01/veeam_immutable_vault' },
    { personality: 'TrueNAS vault by address', hostOrName: '10.30.40.50', mount: 'tank_backup_01/veeam_immutable_vault' },
    { personality: 'Ceph OSD host', hostOrName: 'ceph-osd-nvme-01', mount: '/dev/nvme1n1 (ceph-osd.0 bluestore)' },
    { personality: 'Ceph host by address', hostOrName: '10.30.40.21', mount: '/dev/nvme1n1 (ceph-osd.0 bluestore)' },
    { personality: 'Kubernetes node', hostOrName: 'k8s-gpu-io-worker-01', mount: '10.30.10.55:/fg_llm_datasets_prod' },
  ])('reports load, file systems and memory of a $personality', ({ hostOrName, mount }) => {
    const diagnostics = run(hostOrName, 'uptime && df -h && free -h');
    expect(diagnostics.exitCode).toBe(0);
    const rows = diagnostics.output.split('\r\n');
    expect(rows).toHaveLength(8);
    expect(rows[0]).toContain(`load average: 1.42, 1.38, 1.29 (${hostOrName})`);
    expect(rows[1]).toMatch(/^Filesystem /);
    // The appliance's own file systems follow the root file system.
    expect(rows[3].slice(0, mount.length)).toBe(mount);
    expect(rows[6]).toMatch(/^Mem: /);
    expect(rows[7]).toMatch(/^Swap: /);
  });

  it.each(['netapp-aff-a800-01a', '10.30.10.11'])('reports the ONTAP system instead on %s', (hostOrName) => {
    const diagnostics = run(hostOrName, 'uptime && df -h && free -h');
    expect(diagnostics.exitCode).toBe(0);
    expect(diagnostics.output).toContain('NetApp Release 9.15.1P2');
    expect(diagnostics.output).toContain(`System ID: 0537129481 (${hostOrName})`);
    expect(diagnostics.output).not.toContain('load average');
  });

  it.each(['uptime', 'df -h /var', 'free -h', 'iostat -xz 1 2', 'uname -a', 'systemctl status kubelet', 'ls -la /var/log'])(
    'answers %s with the node diagnostics',
    (cmd) => {
      expect(run(K8S_WORKER.name, cmd)).toEqual(run(K8S_WORKER.name, 'uptime && df -h && free -h'));
    },
  );

  it('acknowledges any other command, as it was typed', () => {
    const whoami = run(K8S_WORKER.name, '  whoami  ');
    expect(whoami.exitCode).toBe(0);
    const [acknowledged, status] = whoami.output.split('\r\n');
    expect(acknowledged).toBe('[demo:k8s-gpu-io-worker-01] Executed: whoami');
    expect(status).toMatch(/^Status: OK \(0 errors, response time 0\.4ms\)\. /);

    expect(run(ONTAP.name, 'Echo Hello').output.split('\r\n')[0]).toBe(
      '[demo:netapp-aff-a800-01a] Executed: Echo Hello',
    );
  });

  it('has a scripted answer for every command the demo suggests', () => {
    // The ONTAP help and banner. `network interface show` has no scripted answer (it gets the
    // generic acknowledgement), so the help does not offer it.
    expect(run(ONTAP.name, 'help').output).not.toContain('network interface show');
    const ontapSuggestions = [
      'qos statistics volume latency show',
      'qos statistics volume performance show',
      'storage aggregate show',
      'volume show',
      'snapmirror show',
      'snapmirror resync',
      'volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling',
      'storage failover show',
      'simulate-error',
    ];
    // The generic help, the other appliances' banners and Tab completion.
    const applianceSuggestions = [
      'uptime && df -h && free -h',
      'kubectl get pods,pvc -A -o wide',
      'kubectl get pods,pvc -A',
      'tridentctl get backend -n trident',
      'multipath -ll',
      'ceph -s && ceph osd df tree',
      'ceph -s',
      'ceph osd df tree',
      'zpool status -v && zfs list',
      'zpool status -v',
      'zpool status',
      'storagegrid-status',
      'aws s3 ls',
      'iostat -xz 1 2',
      'cat /etc/multipath.conf',
      'simulate-error',
    ];
    for (const cmd of ontapSuggestions) {
      expect(run(ONTAP.name, cmd).output, cmd).not.toContain('] Executed: ');
    }
    for (const cmd of applianceSuggestions) {
      expect(run(K8S_WORKER.name, cmd).output, cmd).not.toContain('] Executed: ');
    }
  });
});

describe('executeDemoServerCommand remembers the fixes', () => {
  it('drops the scratch volume latency once the QoS ceiling is applied, and only then', () => {
    const latency = () => run(ONTAP.name, 'qos statistics volume latency show').output;
    const performance = () => run(ONTAP.name, 'qos statistics volume performance show').output;

    expect(cells(line(latency(), 'vol_ai_scratch_03'))).toEqual([
      'vol_ai_scratch_03',
      '4812',
      '2.45ms',
      '0.06ms',
      '0.03ms',
      '1.92ms',
      '0.09ms',
      '0.00ms',
      '0.01ms',
      '0.11ms',
    ]);
    expect(cells(line(latency(), '-total-'))[2]).toBe('1.88ms');
    expect(cells(line(performance(), 'vol_ai_scratch_03'))).toEqual([
      'vol_ai_scratch_03',
      '4812',
      '48200',
      '1680.2MB/s',
      'none',
      '(UNBOUNDED!)',
    ]);

    // Another change to the volume is not the fix.
    const resize = run(ONTAP.name, 'volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -size 30TB');
    expect(resize.output).not.toContain('Volume modify successful');
    expect(cells(line(latency(), 'vol_ai_scratch_03'))[2]).toBe('2.45ms');

    const fix = run(
      ONTAP.name,
      'volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling',
    );
    expect(fix.exitCode).toBe(0);
    expect(fix.output).toContain('QoS policy group set to "pg-batch-ceiling"');

    expect(cells(line(latency(), 'vol_ai_scratch_03'))).toEqual([
      'vol_ai_scratch_03',
      '4812',
      '0.41ms',
      '0.06ms',
      '0.03ms',
      '0.19ms',
      '0.09ms',
      '0.04ms',
      '0.01ms',
      '0.11ms',
    ]);
    expect(cells(line(latency(), '-total-'))[2]).toBe('0.32ms');
    expect(cells(line(latency(), 'vol_pg_prod_db01'))[2]).toBe('0.32ms');
    expect(cells(line(performance(), 'vol_ai_scratch_03'))).toEqual([
      'vol_ai_scratch_03',
      '4812',
      '14950',
      '595.0MB/s',
      'pg-batch-ceiling',
    ]);
  });

  it.each(['snapmirror resync', 'snapmirror update'])(
    'brings the broken DR relation back with %s, the table staying aligned',
    (verb) => {
      const relations = () =>
        run(ONTAP_DR.name, 'snapmirror show')
          .output.split('\r\n')
          .filter((row) => row.startsWith('svm-'));

      const before = relations();
      expect(before).toHaveLength(3);
      expect(cells(before[2]).slice(3)).toEqual(['Broken-off', 'Idle', 'false', '01:42:15']);
      expect(before[2]).toHaveLength(before[0].length);
      expect(before[2].indexOf('Idle')).toBe(before[0].indexOf('Idle'));

      const fix = run(ONTAP_DR.name, `${verb} -destination-path svm-dr-uppsala:vol_ai_checkpoints_dr`);
      expect(fix.exitCode).toBe(0);
      expect(fix.output).toContain('Operation succeeded: snapmirror resync');

      const after = relations();
      expect(cells(after[2]).slice(3)).toEqual(['Snapmirrored', 'Idle', 'true', '00:01:12']);
      expect(after[2]).toHaveLength(after[0].length);
      expect(after[2].indexOf('Idle')).toBe(after[0].indexOf('Idle'));
      expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    },
  );

  it.each(['ceph pg deep-scrub 4.1a', 'ceph config set osd osd_max_backfills 2'])(
    'clears the Ceph health warning with %s',
    (cmd) => {
      const health = () => line(run(CEPH.name, 'ceph -s').output, 'health:');
      expect(health()).toBe('health: HEALTH_WARN (2 pgs not deep-scrubbed in time; 1 slow ops on osd.4)');

      const fix = run(CEPH.name, cmd);
      expect(fix.exitCode).toBe(0);
      expect(fix.output).toContain('HEALTH_WARN -> HEALTH_OK');

      expect(health()).toBe('health: HEALTH_OK');
    },
  );

  it.each(['multipath -r', 'sudo systemctl reload multipathd'])(
    "fixes the GPU worker's multipath policy with %s",
    (cmd) => {
      const policy = () => line(run(K8S_WORKER.name, 'multipath -ll').output, 'policy:');
      const configured = () => line(run(K8S_WORKER.name, 'cat /etc/multipath.conf').output, 'path_grouping_policy');
      expect(policy()).toBe('policy: multibus (WARNING: Non-ALUA policy! Should be group_by_prio)');
      expect(configured()).toBe('path_grouping_policy multibus');

      const fix = run(K8S_WORKER.name, cmd);
      expect(fix.exitCode).toBe(0);
      expect(fix.output).toContain('reload: 3600a0980383146525a2b516a4b38724d');

      expect(policy()).toBe('policy: group_by_prio (ALUA Active/Optimized)');
      expect(configured()).toBe('path_grouping_policy group_by_prio');
    },
  );
});

describe('DemoVirtualPty', () => {
  describe('lifecycle', () => {
    it('presents itself as a demo ssh process of the requested size', () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const pty = new demo.DemoVirtualPty(ONTAP, 132, 43);
        expect(pty.pid).toBe(44500);
        expect(pty.process).toBe('demo-ssh:netapp-aff-a800-01a');
        expect([pty.cols, pty.rows]).toEqual([132, 43]);
        expect(pty.handleFlowControl).toBe(false);
      } finally {
        random.mockRestore();
      }

      const unnamed = new demo.DemoVirtualPty(server('', '10.30.50.10'));
      expect([unnamed.cols, unnamed.rows]).toEqual([100, 30]);
      expect(unnamed.process).toBe('demo-ssh:10.30.50.10');
      expect(unnamed.pid).toBeGreaterThanOrEqual(40000);
      expect(unnamed.pid).toBeLessThan(49000);
    });

    it('greets 30 ms after it was created, once', () => {
      const pty = new demo.DemoVirtualPty(ONTAP);
      const printed: string[] = [];
      pty.onData((data) => {
        printed.push(data);
      });

      vi.advanceTimersByTime(29);
      expect(printed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(printed).toHaveLength(1);
      expect(printed[0].endsWith(ONTAP_PROMPT)).toBe(true);

      vi.advanceTimersByTime(60_000);
      expect(printed).toHaveLength(1);
    });

    it.each([
      {
        label: 'an ONTAP node',
        config: ONTAP,
        title: 'NetApp ONTAP 9.15.1P2 Cluster Shell — netapp-aff-a800-01a (10.30.10.11)',
        cluster: 'Cluster: NetApp-ONTAP-Prod-SE | HA State: Connected (NVMe-oF Sync OK)',
        prompt: 'NetApp-ONTAP-Prod-SE::> ',
      },
      {
        label: 'the ONTAP DR system',
        config: ONTAP_DR,
        title: 'NetApp ONTAP 9.15.1P2 Cluster Shell — netapp-fas9000-dr-01 (10.30.20.11)',
        cluster: 'Cluster: NetApp-ONTAP-Prod-SE | HA State: Connected (NVMe-oF Sync OK)',
        prompt: 'NetApp-DR-Uppsala::> ',
      },
      {
        label: 'a StorageGRID node',
        config: STORAGEGRID,
        title: 'NetApp StorageGRID 11.8 / S3 Appliance — sg-admin-primary-01 (10.30.30.10)',
        cluster: 'Cluster: NetApp-StorageGRID-S3 | ILM Policy: ILM-Prod-FabricPool-EC63 (6+3)',
        prompt: 'admin@sg-admin-primary-01:~# ',
      },
      {
        label: 'the MinIO edge cache',
        config: MINIO,
        title: 'NetApp StorageGRID 11.8 / S3 Appliance — minio-aistor-edge-01 (10.30.30.40)',
        cluster: 'Cluster: NetApp-StorageGRID-S3 | ILM Policy: ILM-Prod-FabricPool-EC63 (6+3)',
        prompt: 'ubuntu@minio-aistor-edge-01:~$ ',
      },
      {
        label: 'a Ceph node',
        config: CEPH,
        title: 'Ceph Reef 18.2.4 NVMe & TrueNAS OpenZFS — ceph-mon-mgr-01 (10.30.40.10)',
        cluster: 'Cluster: Ceph-NVMe-Block-Pool | Network: Dual 100GbE RoCEv2',
        prompt: 'cephadm@ceph-mon-mgr-01:~$ ',
      },
      {
        label: 'the TrueNAS vault',
        config: TRUENAS,
        title: 'Ceph Reef 18.2.4 NVMe & TrueNAS OpenZFS — truenas-zfs-vault-01 (10.30.40.50)',
        cluster: 'Cluster: Ceph-NVMe-Block-Pool | Network: Dual 100GbE RoCEv2',
        prompt: 'truenas_admin@truenas-zfs-vault-01:~$ ',
      },
      {
        label: 'a Kubernetes node',
        config: K8S_WORKER,
        title: 'Ubuntu 24.04.1 LTS (Kubernetes 1.31 + NetApp Astra Trident 24.06) — k8s-gpu-io-worker-01',
        cluster: 'Cluster: K8s-Trident-CSI-Prod | Multipath: DM-Multipath NVMe/iSCSI + NFSv4.1',
        prompt: 'ubuntu@k8s-gpu-io-worker-01:~$ ',
      },
      {
        label: 'a node of a cluster of its own',
        config: server('k8s-storage-cp-01', '10.30.50.10', { username: 'root', cluster: 'K8s-Lab' }),
        title: 'Ubuntu 24.04.1 LTS (Kubernetes 1.31 + NetApp Astra Trident 24.06) — k8s-storage-cp-01',
        cluster: 'Cluster: K8s-Lab | Multipath: DM-Multipath NVMe/iSCSI + NFSv4.1',
        prompt: 'root@k8s-storage-cp-01:~# ',
      },
    ])('greets $label with its appliance banner and prompt', ({ config, title, cluster, prompt }) => {
      const lines = plain(open(config).banner).split('\r\n');
      expect(lines[0]).toMatch(/^=+$/);
      expect(lines[1]).toBe(`  ${title}`);
      expect(lines[2]).toBe(`  ${cluster}`);
      expect(lines.at(-2)).toMatch(/^=+$/);
      expect(lines.at(-1)).toBe(prompt);
    });

    it('goes by the address when the profile has no name', () => {
      const t = open(server('', '10.30.10.11'));
      expect(t.pty.process).toBe('demo-ssh:10.30.10.11');
      expect(t.prompt).toBe(ONTAP_PROMPT);
      expect(plain(t.send('uptime\r'))).toContain('System ID: 0537129481 (10.30.10.11)');
    });

    it('prompts as root, or on a generic node, when the profile leaves the user or the names out', () => {
      expect(plain(open(server('', '10.30.50.10', { username: '' })).prompt)).toBe('root@10.30.50.10:~# ');
      expect(plain(open(server('', '', { username: 'ops' })).prompt)).toBe('ops@demo-node:~$ ');
    });

    it("doesn't greet when it was closed before the banner was due", () => {
      const pty = new demo.DemoVirtualPty(ONTAP);
      const printed: string[] = [];
      const exits: Array<{ exitCode: number; signal?: number }> = [];
      pty.onData((data) => {
        printed.push(data);
      });
      pty.onExit((event) => {
        exits.push(event);
      });

      pty.kill();
      vi.advanceTimersByTime(30);
      expect(printed).toEqual([]);
      expect(exits).toEqual([{ exitCode: 0 }]);
    });

    it('takes a new size without printing anything', () => {
      const t = open(ONTAP);
      t.pty.resize(160, 48);
      expect([t.pty.cols, t.pty.rows]).toEqual([160, 48]);
      expect(t.printed()).toBe('');
    });

    it('has no flow control: pausing and resuming change nothing', () => {
      const t = open(ONTAP);
      t.pty.pause();
      expect(plain(t.send('volume show\r'))).toContain('5 entries were displayed.');
      t.pty.resume();
      expect(t.printed()).toBe('');
    });

    it('clears the screen when asked to and prompts again', () => {
      const t = open(K8S_WORKER);
      t.pty.clear();
      expect(t.printed()).toBe(`${CLEAR_SCREEN}${t.prompt}`);
    });

    it('stops calling a listener once it is disposed', () => {
      const pty = new demo.DemoVirtualPty(ONTAP);
      const first: string[] = [];
      const second: string[] = [];
      const subscription = pty.onData((data) => {
        first.push(data);
      });
      pty.onData((data) => {
        second.push(data);
      });
      const firstExits: number[] = [];
      const secondExits: number[] = [];
      const exitSubscription = pty.onExit((event) => {
        firstExits.push(event.exitCode);
      });
      pty.onExit((event) => {
        secondExits.push(event.exitCode);
      });

      vi.advanceTimersByTime(30);
      expect(first).toHaveLength(1);
      subscription.dispose();
      pty.write('volume show\r');
      expect(first).toHaveLength(1);
      expect(second.join('')).toContain('5 entries were displayed.');

      exitSubscription.dispose();
      pty.kill('SIGTERM');
      expect(firstExits).toEqual([]);
      expect(secondExits).toEqual([0]);
    });

    it('ends once on kill, with exit code 0, and goes quiet', () => {
      const t = open(ONTAP);
      t.pty.kill();
      t.pty.kill();
      expect(t.exits).toEqual([{ exitCode: 0 }]);
      expect(t.send('volume show\r')).toBe('');
      t.pty.clear();
      expect(t.printed()).toBe('');
    });

    it('shares what was fixed with every other demo terminal', () => {
      const prod = open(ONTAP);
      const partner = open(ONTAP_PARTNER);
      const scratchLatency = () =>
        cells(line(plain(prod.send('qos statistics volume latency show\r')), 'vol_ai_scratch_03'))[2];

      expect(scratchLatency()).toBe('2.45ms');
      partner.send('volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling\r');
      expect(scratchLatency()).toBe('0.41ms');
    });
  });

  describe('typing', () => {
    it('echoes the keys typed and runs the line on Enter, closing it with its exit code for the terminal registry', () => {
      const t = open(ONTAP);
      expect(t.send('storage aggregate show')).toBe('storage aggregate show');
      const aggregates = run(ONTAP.name, 'storage aggregate show').output;
      expect(t.send('\r')).toBe(`\r\n${aggregates}\r\n${commandDone(0)}${ONTAP_PROMPT}`);

      const volumes = run(ONTAP.name, 'volume show').output;
      expect(t.send('volume show\n')).toBe(`volume show\r\n${volumes}\r\n${commandDone(0)}${ONTAP_PROMPT}`);
    });

    it('closes a failing command with its exit code', () => {
      const worker = open(K8S_WORKER);
      const mountFailure = run(K8S_WORKER.name, 'simulate-error').output;
      expect(worker.send('simulate-error\r')).toBe(
        `simulate-error\r\n${mountFailure}\r\n${commandDone(32)}${worker.prompt}`,
      );

      const ontap = open(ONTAP);
      const snapMirrorFailure = run(ONTAP.name, 'simulate-error').output;
      expect(ontap.send('simulate-error\r')).toBe(
        `simulate-error\r\n${snapMirrorFailure}\r\n${commandDone(1)}${ONTAP_PROMPT}`,
      );
    });

    it('runs every line of a paste, in order', () => {
      const t = open(ONTAP);
      const printed = plain(t.send('volume show\rsnapmirror show\r'));
      expect(printed.indexOf('5 entries were displayed.')).toBeGreaterThan(-1);
      expect(printed.indexOf('3 entries were displayed.')).toBeGreaterThan(printed.indexOf('5 entries were displayed.'));
    });

    it('answers an empty line with a new prompt, keeping it out of the history', () => {
      const t = open(ONTAP);
      expect(t.send('\r')).toBe(`\r\n${ONTAP_PROMPT}`);
      expect(t.send('   \r')).toBe(`   \r\n${ONTAP_PROMPT}`);
      expect(t.send(ARROW_UP)).toBe('');
    });

    it('erases the last character on Backspace, sent as DEL or BS', () => {
      const t = open(ONTAP);
      expect(t.send('volx')).toBe('volx');
      expect(t.send('\x7f')).toBe(ERASE);
      expect(t.send('\b')).toBe(ERASE);
      expect(plain(t.send('lume show\r'))).toContain('5 entries were displayed.');
      // Nothing left to erase on the new line.
      expect(t.send('\x7f')).toBe('');
    });

    it('drops the line on Ctrl+C and starts over at a new prompt', () => {
      const t = open(ONTAP);
      t.send('volume show\r');
      t.send('storage agg');
      expect(t.send('\x03')).toBe(`^C\r\n${ONTAP_PROMPT}`);
      expect(t.send('\r')).toBe(`\r\n${ONTAP_PROMPT}`);

      // Browsing the history starts over from the newest command too.
      expect(t.send(ARROW_UP)).toBe('volume show');
      expect(t.send('\x03')).toBe(`^C\r\n${ONTAP_PROMPT}`);
      expect(t.send(ARROW_UP)).toBe('volume show');
    });

    it('clears the screen on Ctrl+L and redraws the line being typed', () => {
      const t = open(ONTAP);
      t.send('snap');
      expect(t.send('\x0c')).toBe(`${CLEAR_SCREEN}${ONTAP_PROMPT}snap`);
      expect(plain(t.send('mirror show\r'))).toContain('3 entries were displayed.');
    });

    it('clears the screen for clear, which stays out of the history', () => {
      const t = open(ONTAP);
      expect(t.send('clear\r')).toBe(`clear\r\n${CLEAR_SCREEN}${ONTAP_PROMPT}`);
      expect(t.send(ARROW_UP)).toBe('');
    });

    it.each(['exit', 'logout'])('logs out on %s: the session ends and the terminal goes quiet', (cmd) => {
      const t = open(K8S_WORKER);
      // What follows the logout in the same write is not run.
      expect(t.send(`${cmd}\rvolume show\r`)).toBe(`${cmd}\r\nlogout\r\n`);
      expect(t.exits).toEqual([{ exitCode: 0 }]);
      expect(t.send('volume show\r')).toBe('');
      t.pty.kill();
      expect(t.exits).toHaveLength(1);
    });

    it('browses the command history with the arrow keys', () => {
      const t = open(ONTAP);
      t.send('volume show\r');
      t.send('snapmirror show\r');

      expect(t.send(ARROW_UP)).toBe('snapmirror show');
      expect(t.send(ARROW_UP)).toBe(`${ERASE.repeat('snapmirror show'.length)}volume show`);
      // Already at the oldest command.
      expect(t.send(ARROW_UP)).toBe('');
      expect(t.send(ARROW_DOWN)).toBe(`${ERASE.repeat('volume show'.length)}snapmirror show`);
      // Back to the empty line, and no further.
      expect(t.send(ARROW_DOWN)).toBe(ERASE.repeat('snapmirror show'.length));
      expect(t.send(ARROW_DOWN)).toBe('');

      t.send(ARROW_UP + ARROW_UP);
      expect(plain(t.send('\r'))).toContain('5 entries were displayed.');
      // The recalled command ran and is the newest one now.
      expect(t.send(ARROW_UP)).toBe('volume show');
    });

    it('ignores the other cursor keys', () => {
      const t = open(ONTAP);
      expect(t.send(`vol${ARROW_LEFT}${ARROW_RIGHT}ume show`)).toBe('volume show');
      expect(plain(t.send('\r'))).toContain('5 entries were displayed.');
    });

    it('completes a demo command on Tab', () => {
      const t = open(ONTAP);
      t.send('sto');
      expect(t.send('\t')).toBe(`${ERASE.repeat(3)}storage aggregate show`);
      expect(plain(t.send('\r'))).toContain('4 entries were displayed.');

      t.send('storageg');
      expect(t.send('\t')).toBe(`${ERASE.repeat(8)}storagegrid-status`);
      t.send('\x03');

      // On an empty line: the first suggestion.
      expect(t.send('\t')).toBe('qos statistics volume latency show');
      t.send('\x03');

      // Already complete, or nothing to suggest.
      t.send('ceph -s');
      expect(t.send('\t')).toBe('');
      t.send('\x03');
      t.send('whoami');
      expect(t.send('\t')).toBe('');
    });

    it('swallows control characters it has no use for instead of typing them', () => {
      const t = open(ONTAP);
      expect(t.send('\x01\x1b\x1a')).toBe('');
      expect(t.send('clear\r')).toBe(`clear\r\n${CLEAR_SCREEN}${ONTAP_PROMPT}`);
    });
  });

  // The framing the demo terminal recognises. (TerminalRegistry's current envelopes, from
  // shellAdapters.commandEnvelope, use OSC 777 SSHS3 marks instead: those arrive as typed text.)
  describe('commands framed with __SSHS3_START_/__SSHS3_END_ markers', () => {
    it('runs the command of a bash frame and answers between the markers, without typing it', () => {
      const t = open(ONTAP);
      const framed = `printf '__SSHS3_START_k9x2__\\n'; storage aggregate show; __sshs3_ec=$?; printf '__SSHS3_END_k9x2__:%s\\n' "$__sshs3_ec"\r`;
      const aggregates = run(ONTAP.name, 'storage aggregate show').output;
      expect(t.send(framed)).toBe(
        `\r\nstorage aggregate show\r\n__SSHS3_START_k9x2__\r\n${aggregates}\r\n__SSHS3_END_k9x2__:0\r\n${commandDone(0)}${ONTAP_PROMPT}`,
      );
      // Nothing of it was typed: the history and the line are as they were.
      expect(t.send(ARROW_UP)).toBe('');
      expect(t.send('clear\r')).toBe(`clear\r\n${CLEAR_SCREEN}${ONTAP_PROMPT}`);
    });

    it('runs the command of a PowerShell frame and reports its exit code', () => {
      const t = open(K8S_WORKER);
      const framed = `Write-Output '__SSHS3_START_k9x2__'; simulate-error; $__sshs3_ec = $LASTEXITCODE; Write-Output "__SSHS3_END_k9x2__:$__sshs3_ec"\r`;
      const mountFailure = run(K8S_WORKER.name, 'simulate-error').output;
      expect(t.send(framed)).toBe(
        `\r\nsimulate-error\r\n__SSHS3_START_k9x2__\r\n${mountFailure}\r\n__SSHS3_END_k9x2__:32\r\n${commandDone(32)}${t.prompt}`,
      );
    });

    it('runs the whole text when it finds no command between the markers', () => {
      const t = open(K8S_WORKER);
      const framed = 'echo __SSHS3_START_k9x2__ && whoami && echo __SSHS3_END_k9x2__';
      const answer = run(K8S_WORKER.name, framed).output;
      expect(answer).toContain(`Executed: ${framed}`);
      expect(t.send(framed)).toBe(
        `\r\n${framed}\r\n__SSHS3_START_k9x2__\r\n${answer}\r\n__SSHS3_END_k9x2__:0\r\n${commandDone(0)}${t.prompt}`,
      );
    });

    it('takes a start marker without an end marker as typing', () => {
      const t = open(K8S_WORKER);
      expect(t.send('__SSHS3_START_k9x2__')).toBe('__SSHS3_START_k9x2__');
    });
  });
});
