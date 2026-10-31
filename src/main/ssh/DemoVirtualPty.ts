import type { IPty, IDisposable } from 'node-pty';
import type { SSHConnectionConfig } from '../../shared/types/ssh';

interface DemoClusterMutableState {
  ontapQosFixed: boolean;
  snapmirrorResynced: boolean;
  cephScrubFixed: boolean;
  multipathFixed: boolean;
}

const demoClusterState: DemoClusterMutableState = {
  ontapQosFixed: false,
  snapmirrorResynced: false,
  cephScrubFixed: false,
  multipathFixed: false,
};

export function isDemoSshTarget(config: SSHConnectionConfig, demoModeActive: boolean): boolean {
  if (!demoModeActive) return false;
  if (config.id?.startsWith('demo-')) return true;
  if (config.host?.startsWith('10.30.')) return true;
  return false;
}

export function executeDemoServerCommand(
  hostOrName: string,
  rawCmd: string
): { output: string; exitCode: number } {
  const cmd = rawCmd.trim();
  const lower = cmd.toLowerCase();
  const h = hostOrName.toLowerCase();

  const isOntap =
    h.includes('netapp') ||
    h.includes('aff-') ||
    h.includes('fas9000') ||
    h.includes('10.30.10.11') ||
    h.includes('10.30.10.12') ||
    h.includes('10.30.20.11');
  const isStorageGrid =
    h.includes('sg-') ||
    h.includes('storagegrid') ||
    h.includes('minio') ||
    h.includes('10.30.30.');
  const isCephOrZfs =
    h.includes('ceph') ||
    h.includes('truenas') ||
    h.includes('zfs') ||
    h.includes('10.30.40.');
  const isZfs = h.includes('truenas') || h.includes('zfs') || h.includes('10.30.40.50');

  if (!cmd) {
    return { output: '', exitCode: 0 };
  }

  if (lower === 'help' || lower === '?') {
    if (isOntap) {
      return {
        exitCode: 0,
        output: [
          '\x1b[1;36mNetApp ONTAP 9.15.1 Interactive Demo CLI — Tillgängliga kommandon:\x1b[0m',
          '  \x1b[33mqos statistics volume latency show\x1b[0m      Visa latens per volym & WAFL/QoS-center',
          '  \x1b[33mqos statistics volume performance show\x1b[0m  Visa IOPS & throughput per FlexVol',
          '  \x1b[33mstorage aggregate show\x1b[0m                  Visa NVMe RAID-TEC aggregat & FabricPool',
          '  \x1b[33mvolume show\x1b[0m                             Lista alla FlexVol & FlexGroup-volymer',
          '  \x1b[33msnapmirror show\x1b[0m                         Visa SnapMirror XDP-replikering till Uppsala DC2',
          '  \x1b[33msnapmirror resync\x1b[0m                       Återuppta bruten SnapMirror-relation',
          '  \x1b[33mvolume modify ... -qos-policy-group ...\x1b[0m Applicera QoS-tak på noisy-neighbor-volym',
          '  \x1b[33mstorage failover show\x1b[0m                   Visa HA-par & NVRAM-synkstatus',
          '  \x1b[33mnetwork interface show\x1b[0m                  Visa LIF:ar (NFSv4.1, iSCSI, Intercluster)',
          '  \x1b[33msimulate-error\x1b[0m                          Simulera ett lagringsfel (testa "✨ Förklara & fixa felet")',
        ].join('\r\n'),
      };
    }
    return {
      exitCode: 0,
      output: [
        `\x1b[1;36msshs3 Interactive Demo Appliance (${hostOrName}) — Förslag på kommandon:\x1b[0m`,
        '  \x1b[33muptime && df -h && free -h\x1b[0m              Systemlast, filsystem & RAM',
        '  \x1b[33mkubectl get pods,pvc -A -o wide\x1b[0m         Kubernetes pods & Astra Trident PVCs',
        '  \x1b[33mtridentctl get backend -n trident\x1b[0m       Lista NetApp Astra Trident CSI backends',
        '  \x1b[33mmultipath -ll\x1b[0m                           Visa DM-Multipath ALUA LUN-vägar',
        '  \x1b[33mceph -s && ceph osd df tree\x1b[0m             Ceph Reef NVMe-klusterstatus & OSD-träd',
        '  \x1b[33mzpool status -v && zfs list\x1b[0m             TrueNAS OpenZFS RAIDZ3 & snapshots',
        '  \x1b[33mstoragegrid-status\x1b[0m                      NetApp StorageGRID 11.8 S3 & ILM-status',
        '  \x1b[33mcat /etc/multipath.conf\x1b[0m                 Inspektera multipath-konfiguration',
        '  \x1b[33msimulate-error\x1b[0m                          Simulera ett terminalfel (triggar "✨ Förklara & fixa felet")',
      ].join('\r\n'),
    };
  }

  // Simulated Error Trigger so the user can test the proactive "✨ Förklara & fixa felet" button
  if (
    lower === 'simulate-error' ||
    lower === 'test-error' ||
    lower.includes('mount /mnt/pvc') ||
    lower.includes('describe pvc pvc-llm-checkpoints-02')
  ) {
    if (isOntap) {
      return {
        exitCode: 1,
        output: [
          '\x1b[1;31mError: command failed: SnapMirror transfer for destination "svm-dr-uppsala:vol_ai_checkpoints_dr" aborted.\x1b[0m',
          'Reason: CSM connection degraded on intercluster LIF "ic-dc1-01a" (10.30.90.11 -> 10.30.90.21): MTU 9000 jumbo frame fragmentation detected.',
          'Last Transfer Error: replication transfer failed to complete within RPO window (lag-time: 01:42:15, state: Broken-off).',
          'Hint: Run "cluster peer ping -aca true" and "snapmirror resync -destination-path svm-dr-uppsala:vol_ai_checkpoints_dr".',
        ].join('\r\n'),
      };
    }
    return {
      exitCode: 32,
      output: [
        '\x1b[1;31mMountVolume.SetUp failed for volume "pvc-8f92a1b0" (UniqueName: "kubernetes.io/csi/csi.trident.netapp.io^pvc-8f92a1b0") :\x1b[0m',
        'rpc error: code = Internal desc = unable to mount device /dev/mapper/3600a0980383146525a2b516a4b38724d:',
        'multipathd: 3600a0980383146525a2b516a4b38724d: path_grouping_policy mismatch (configured: multibus, expected ALUA: group_by_prio).',
        'mount.nfs4: access denied by server while mounting 10.30.10.55:/vol_ai_scratch_03 (export-policy rule missing for subnet 10.30.50.0/24).',
      ].join('\r\n'),
    };
  }

  // Stateful Remediation Commands
  if (lower.includes('volume modify') && lower.includes('pg-batch-ceiling')) {
    demoClusterState.ontapQosFixed = true;
    return {
      exitCode: 0,
      output:
        '\x1b[1;32mVolume modify successful on volume "vol_ai_scratch_03" in Vserver "svm-prod-nfs": QoS policy group set to "pg-batch-ceiling" (max-throughput: 15000iops,600MB/s).\x1b[0m\r\n' +
        'WAFL read latency on aggr2_nvme_db dropped from 2.45 ms -> 0.34 ms.',
    };
  }

  if (lower.includes('snapmirror resync') || lower.includes('snapmirror update')) {
    demoClusterState.snapmirrorResynced = true;
    return {
      exitCode: 0,
      output:
        '\x1b[1;32mOperation succeeded: snapmirror resync for destination "svm-dr-uppsala:vol_ai_checkpoints_dr".\x1b[0m\r\n' +
        'Transfer status: Transferring (incremental XDP resync complete, lag-time reset to 00:00:42, Healthy: true).',
    };
  }

  if (
    lower.includes('ceph pg deep-scrub') ||
    lower.includes('osd_max_backfills')
  ) {
    demoClusterState.cephScrubFixed = true;
    return {
      exitCode: 0,
      output:
        '\x1b[1;32minstructing pg 4.1a on osd.4 to deep-scrub; osd_max_backfills updated to 2.\x1b[0m\r\n' +
        'Cluster status transitioned: HEALTH_WARN -> HEALTH_OK.',
    };
  }

  if (lower.includes('multipath -r') || lower.includes('systemctl reload multipathd')) {
    demoClusterState.multipathFixed = true;
    return {
      exitCode: 0,
      output:
        '\x1b[1;32mreload: 3600a0980383146525a2b516a4b38724d undef NETAPP,LUN C-Mode\x1b[0m\r\n' +
        'size=4.0T features="3 queue_if_no_path pg_init_retries 50" hwhandler="1 alua" wp=rw\r\n' +
        '|-+- policy="service-time 0" prio=50 status=active (ALUA Optimized)',
    };
  }

  // ONTAP Commands
  if (lower.includes('qos statistics volume latency show')) {
    const scratchLatency = demoClusterState.ontapQosFixed ? '0.41ms' : '2.45ms';
    const dbLatency = demoClusterState.ontapQosFixed ? '0.32ms' : '1.88ms';
    return {
      exitCode: 0,
      output: [
        'Workload               ID     Latency    Network    Cluster       Data       Disk    QoS-Max      NVRAM       WAFL',
        '--------------- --------- ---------- ---------- ---------- ---------- ---------- ---------- ---------- ----------',
        `-total-                 -     ${dbLatency}     0.05ms     0.02ms     0.18ms     0.07ms     0.00ms     0.01ms     0.04ms`,
        `vol_ai_scratch_03    4812     ${scratchLatency}     0.06ms     0.03ms     ${demoClusterState.ontapQosFixed ? '0.19ms' : '1.92ms'}     0.09ms     ${demoClusterState.ontapQosFixed ? '0.04ms' : '0.00ms'}     0.01ms     0.11ms`,
        `vol_pg_prod_db01     4109     ${dbLatency}     0.04ms     0.01ms     0.15ms     0.08ms     0.00ms     0.02ms     0.02ms`,
        'vol_k8s_pvc_prod     3904     0.38ms     0.05ms     0.01ms     0.21ms     0.08ms     0.00ms     0.01ms     0.02ms',
      ].join('\r\n'),
    };
  }

  if (lower.includes('qos statistics volume performance show')) {
    return {
      exitCode: 0,
      output: [
        'Workload               ID       IOPS       Throughput    QoS Policy Group',
        '--------------- --------- ---------- ---------------- --------------------',
        '-total-                 -      64820        2140.5MB/s   -',
        `vol_ai_scratch_03    4812      ${demoClusterState.ontapQosFixed ? '14950' : '48200'}        ${demoClusterState.ontapQosFixed ? '595.0MB/s' : '1680.2MB/s'}   ${demoClusterState.ontapQosFixed ? 'pg-batch-ceiling' : 'none (UNBOUNDED!)'}`,
        'vol_pg_prod_db01     4109      28400         312.4MB/s   pg-prod-db-extreme',
        'vol_k8s_pvc_prod     3904      11270         147.9MB/s   pg-trident-premium',
      ].join('\r\n'),
    };
  }

  if (lower.includes('storage aggregate show')) {
    return {
      exitCode: 0,
      output: [
        'Aggregate         Size    Available   Used%   State    #Vols  Nodes                RAID Status            FabricPool Target',
        '----------------  ------  ----------  -----   -------  -----  -------------------  ---------------------  ------------------------',
        'aggr0_root_01a    1.68TB      412GB     75%   online       1  netapp-aff-a800-01a  raid_dp, normal        -',
        'aggr0_root_01b    1.68TB      418GB     75%   online       1  netapp-aff-a800-01b  raid_dp, normal        -',
        'aggr1_nvme_prod    220TB     61.6TB     72%   online      42  netapp-aff-a800-01a  raid_tec, normal       sg-fabricpool-dc1 (48TB tiered)',
        'aggr2_nvme_db      180TB     57.6TB     68%   online      29  netapp-aff-a800-01b  raid_tec, normal       sg-fabricpool-dc1 (31TB tiered)',
        '4 entries were displayed.',
      ].join('\r\n'),
    };
  }

  if (lower.includes('volume show')) {
    return {
      exitCode: 0,
      output: [
        'Vserver         Volume                 Aggregate        State      Type       Size     Available  Used%  Tiering Policy',
        '--------------  ---------------------  ---------------  ---------  ---------  -------  ---------  -----  --------------',
        'svm-prod-nfs    vol_k8s_pvc_prod       aggr1_nvme_prod  online     RW          16.0TB     4.16TB    74%  snapshot-only',
        'svm-prod-nfs    vol_ai_scratch_03      aggr2_nvme_db    online     RW          24.0TB     3.84TB    84%  auto',
        'svm-prod-nfs    fg_llm_datasets_prod   aggr1_nvme_prod  online     RW-FG       80.0TB    22.40TB    72%  auto',
        'svm-prod-iscsi  vol_pg_prod_db01       aggr2_nvme_db    online     RW          12.0TB     4.68TB    61%  snapshot-only',
        'svm-prod-s3     fg_ontap_s3_buckets    aggr1_nvme_prod  online     RW-FG       40.0TB    14.00TB    65%  auto',
        '5 entries were displayed.',
      ].join('\r\n'),
    };
  }

  if (lower.includes('snapmirror show')) {
    const drState = demoClusterState.snapmirrorResynced ? 'Snapmirrored' : 'Broken-off';
    const drHealthy = demoClusterState.snapmirrorResynced ? 'true' : 'false';
    const drLag = demoClusterState.snapmirrorResynced ? '00:01:12' : '01:42:15';
    return {
      exitCode: 0,
      output: [
        'Source Path                        Type  Destination Path                     State          Status  Healthy  Lag-Time',
        '---------------------------------  ----  -----------------------------------  -------------  ------  -------  --------',
        'svm-prod-nfs:vol_k8s_pvc_prod      XDP   svm-dr-uppsala:vol_k8s_pvc_dr        Snapmirrored   Idle    true     00:03:18',
        'svm-prod-iscsi:vol_pg_prod_db01    XDP   svm-dr-uppsala:vol_pg_prod_db01_dr   Snapmirrored   Idle    true     00:02:44',
        `svm-prod-nfs:fg_llm_datasets_prod  XDP   svm-dr-uppsala:vol_ai_checkpoints_dr ${drState.padEnd(13)}  Idle    ${drHealthy.padEnd(7)}  ${drLag}`,
        '3 entries were displayed.',
      ].join('\r\n'),
    };
  }

  if (lower.includes('storage failover show')) {
    return {
      exitCode: 0,
      output: [
        '                              Takeover',
        'Node           Partner        Possible State Description',
        '-------------- -------------- -------- -------------------------------------',
        'netapp-aff-a800-01a',
        '               netapp-aff-a800-01b',
        '                              true     Connected to netapp-aff-a800-01b (NVMe-oF HA Sync OK)',
        'netapp-aff-a800-01b',
        '               netapp-aff-a800-01a',
        '                              true     Connected to netapp-aff-a800-01a (NVMe-oF HA Sync OK)',
      ].join('\r\n'),
    };
  }

  // StorageGRID & S3 Commands
  if (lower.includes('storagegrid-status') || lower.includes('storagegrid-cli')) {
    return {
      exitCode: 0,
      output: [
        'NetApp StorageGRID 11.8.0.4 — Grid Status: HEALTHY (Multi-Site EC 6+3)',
        '--------------------------------------------------------------------------------',
        'Node                     Site              Role                   State     S3 Req/s   p99 Latency   ILM Queue',
        'sg-admin-primary-01      Stockholm-DC1     Primary Admin + LB     Online       4,820        2.1 ms          14',
        'sg-sn-nvme-01            Stockholm-DC1     Storage Node (SG6060)  Online       2,610        3.4 ms          42',
        'sg-sn-nvme-02            Stockholm-DC1     Storage Node (SG6060)  Online       2,210        3.6 ms          38',
        'minio-aistor-edge-01     Stockholm-DC1     NVMe AI Cache Tier     Online      18,400        0.8 ms           0',
        'Active ILM Policy: ILM-Prod-FabricPool-EC63 (Erasure Coding 6+3, S3 Object Lock WORM: Compliant)',
      ].join('\r\n'),
    };
  }

  if (lower.includes('aws ') && lower.includes('s3 ls')) {
    return {
      exitCode: 0,
      output: [
        '2026-04-12 08:15:22 ontap-fabricpool-tier (79.4 TB, S3 Object Lock: COMPLIANCE)',
        '2026-06-01 14:20:10 llm-checkpoints-prod (34.2 TB, All-NVMe Tier)',
        '2026-07-19 19:04:55 veeam-immutable-vault (112.8 TB, WORM 90d Retention)',
        '2026-09-03 11:30:00 sshs3-team-workspace (Shared Team AI Memory & Runbooks)',
      ].join('\r\n'),
    };
  }

  // Ceph & ZFS Commands
  if (lower.startsWith('ceph') || lower.includes('ceph -s') || lower.includes('ceph status') || lower.includes('ceph osd')) {
    const health = demoClusterState.cephScrubFixed
      ? 'HEALTH_OK'
      : 'HEALTH_WARN (2 pgs not deep-scrubbed in time; 1 slow ops on osd.4)';
    if (lower.includes('osd df')) {
      return {
        exitCode: 0,
        output: [
          'ID  CLASS  WEIGHT    REWEIGHT  SIZE     RAW USE  DATA     OMAP     META     AVAIL    %USE   VAR   PGS  STATUS  TYPE NAME',
          ' -1         491.52000         -  491 TiB  314 TiB  310 TiB  1.2 TiB  2.8 TiB  177 TiB  63.88  1.00    -          root default',
          ' -3         245.76000         -  245 TiB  158 TiB  156 TiB  620 GiB  1.4 TiB   87 TiB  64.28  1.01    -              host ceph-osd-nvme-01',
          '  0   nvme   15.36000   1.00000   15 TiB  9.8 TiB  9.6 TiB   40 GiB   90 GiB  5.5 TiB  63.95  1.00  128      up          osd.0',
          '  1   nvme   15.36000   1.00000   15 TiB  9.9 TiB  9.7 TiB   41 GiB   91 GiB  5.4 TiB  64.45  1.01  128      up          osd.1',
          '  4   nvme   15.36000   1.00000   15 TiB   11 TiB   10 TiB   45 GiB   98 GiB  4.3 TiB  71.20  1.11  134      up          osd.4',
        ].join('\r\n'),
      };
    }
    return {
      exitCode: 0,
      output: [
        '  cluster:',
        '    id:     9b4e7c12-84d0-4f19-a910-55b019283746',
        `    health: ${health}`,
        '  services:',
        '    mon: 3 daemons, quorum ceph-mon-mgr-01,ceph-mon-02,ceph-mon-03 (age 42d)',
        '    mgr: ceph-mon-mgr-01(active, since 42d), standbys: ceph-mon-02',
        '    osd: 32 osds: 32 up (since 42d), 32 in (since 42d); 100GbE RoCEv2',
        '    rgw: 2 daemons active (2 hosts, 1 zones)',
        '  data:',
        '    pools:   6 pools, 1024 pgs',
        '    objects: 84.21M objects, 104 TiB',
        '    usage:   314 TiB used, 177 TiB / 491 TiB avail',
        '    pgs:     1024 active+clean',
        '  io:',
        '    client:  1.8 GiB/s rd, 940 MiB/s wr, 42.1k op/s rd, 18.4k op/s wr',
      ].join('\r\n'),
    };
  }

  if (lower.startsWith('zpool') || lower.startsWith('zfs')) {
    return {
      exitCode: 0,
      output: [
        '  pool: tank_backup_01',
        ' state: ONLINE',
        '  scan: scrub repaired 0B in 04:12:09 with 0 errors on Sun Oct 26 04:12:10 2026',
        'config:',
        '        NAME                                      STATE     READ WRITE CKSUM',
        '        tank_backup_01                            ONLINE       0     0     0',
        '          raidz3-0                                ONLINE       0     0     0',
        '            nvme0n1..nvme11n1 (12x 22TB Ent)      ONLINE       0     0     0',
        '        logs',
        '          mirror-1 (Intel Optane P5800X SLOG)     ONLINE       0     0     0',
        '        cache',
        '          nvme14n1 (2TB Gen5 NVMe L2ARC)          ONLINE       0     0     0',
        '',
        'NAME                                    USED  AVAIL  REFER  COMPRESSRATIO  MOUNTPOINT',
        'tank_backup_01                          984T   416T   192K          2.41x  /mnt/tank_backup_01',
        'tank_backup_01/veeam_immutable_vault    512T   416T   512T          2.58x  /mnt/tank_backup_01/veeam',
        'tank_backup_01/ceph_rbd_nightly         310T   416T   310T          2.19x  /mnt/tank_backup_01/ceph_rbd',
        'tank_backup_01/pgbackrest_wal_archive   162T   416T   162T          2.64x  /mnt/tank_backup_01/pgbackrest',
      ].join('\r\n'),
    };
  }

  // Kubernetes & Trident Commands
  if (lower.startsWith('kubectl') || lower.startsWith('tridentctl')) {
    if (lower.includes('tridentctl')) {
      return {
        exitCode: 0,
        output: [
          '+----------------------------+----------------+--------------------------------------+--------+---------+---------+',
          '|            NAME            | STORAGE DRIVER |                 UUID                 | STATE  | USER-ST | VOLUMES |',
          '+----------------------------+----------------+--------------------------------------+--------+---------+---------+',
          '| tbc-ontap-nas-premium      | ontap-nas      | f4128a90-2b11-4c9a-9182-001122334455 | online | normal  |      38 |',
          '| tbc-ontap-nas-flexgroup-ai | ontap-nas-fg   | a8910c11-7e22-4d1b-8891-556677889900 | online | normal  |      14 |',
          '| tbc-ontap-san-nvme-iscsi   | ontap-san      | c3019b44-9a88-4f0c-b123-998877665544 | online | normal  |      27 |',
          '+----------------------------+----------------+--------------------------------------+--------+---------+---------+',
        ].join('\r\n'),
      };
    }
    return {
      exitCode: 0,
      output: [
        'NAMESPACE     NAME                                      STATUS    VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS          AGE',
        'ai-training   pvc-llm-dataset-flexgroup-01              Bound     pvc-1192a8c0-ontap-fg                      80Ti       RWX            ontap-flexgroup-ai    45d',
        'ai-training   pvc-llm-checkpoints-02                    Bound     pvc-8f92a1b0-ontap-san                     4Ti        RWO            ontap-san-nvme        12d',
        'prod-db       data-postgresql-ha-0                      Bound     pvc-4401b2d9-ontap-san                     12Ti       RWO            ontap-san-nvme        94d',
        'trident       trident-controller-67d9b8f9c-x8k2p        Running   1/1     Node: k8s-storage-cp-01            Restarts: 0                  24.06.1               45d',
        'trident       trident-node-linux-9m4lw                  Running   2/2     Node: k8s-gpu-io-worker-01         Restarts: 0                  24.06.1               45d',
      ].join('\r\n'),
    };
  }

  if (lower.includes('multipath -ll') || lower.includes('cat /etc/multipath.conf')) {
    const policy =
      h.includes('worker') && !demoClusterState.multipathFixed
        ? 'multibus (WARNING: Non-ALUA policy! Should be group_by_prio)'
        : 'group_by_prio (ALUA Active/Optimized)';
    if (lower.includes('cat /etc/multipath.conf')) {
      return {
        exitCode: 0,
        output: [
          'defaults {',
          '    user_friendly_names yes',
          '    find_multipaths yes',
          '}',
          'devices {',
          '    device {',
          '        vendor "NETAPP"',
          '        product "LUN.*"',
          `        path_grouping_policy ${h.includes('worker') && !demoClusterState.multipathFixed ? 'multibus' : 'group_by_prio'}`,
          '        path_checker tur',
          '        features "2 pg_init_retries 50"',
          '        hardware_handler "1 alua"',
          '        prio alua',
          '        failback immediate',
          '        rr_min_io_rq 1',
          '    }',
          '}',
        ].join('\r\n'),
      };
    }
    return {
      exitCode: 0,
      output: [
        '3600a0980383146525a2b516a4b38724d dm-2 NETAPP,LUN C-Mode',
        'size=4.0T features="3 queue_if_no_path pg_init_retries 50" hwhandler="1 alua" wp=rw',
        `policy: ${policy}`,
        '|-+- policy="service-time 0" prio=50 status=active (netapp-aff-a800-01b LIF iscsi-01b)',
        '| |- 6:0:0:1 sdb 8:16 active ready running',
        '| `- 7:0:0:1 sdc 8:32 active ready running',
        '`-+- policy="service-time 0" prio=10 status=enabled (netapp-aff-a800-01a LIF iscsi-01a)',
        '  |- 8:0:0:1 sdd 8:48 active ready running',
        '  `- 9:0:0:1 sde 8:64 active ready running',
      ].join('\r\n'),
    };
  }

  // Generic Linux / Storage Node diagnostics
  if (
    lower.includes('uptime') ||
    lower.includes('df -h') ||
    lower.includes('free -h') ||
    lower.includes('iostat') ||
    lower.includes('uname') ||
    lower.includes('systemctl') ||
    lower.includes('ls')
  ) {
    if (isOntap) {
      return {
        exitCode: 0,
        output: [
          'NetApp Release 9.15.1P2: Tue Sep 15 11:24:00 UTC 2026',
          `System ID: 0537129481 (${hostOrName}); Partner: ha-pair-dc1; Uptime: 148 days, 09:41:12`,
          'Aggregates: aggr1_nvme_prod (72% used, ONLINE), aggr2_nvme_db (68% used, ONLINE)',
          'CPU utilization: 24% | NVRAM latency: 0.01ms | All-Flash NVMe-oF LIFs: 8/8 online',
        ].join('\r\n'),
      };
    }
    return {
      exitCode: 0,
      output: [
        ` 17:32:10 up 142 days,  6:18,  2 users,  load average: 1.42, 1.38, 1.29 (${hostOrName})`,
        'Filesystem                                  Size  Used Avail Use% Mounted on',
        '/dev/nvme0n1p2                              440G   92G  348G  21% /',
        ...(isStorageGrid
          ? [
              '/dev/mapper/sg-rangedb-nvme01                15T  9.4T  5.6T  63% /var/local/rangedb/0',
              '/dev/mapper/sg-rangedb-nvme02                15T  9.1T  5.9T  61% /var/local/rangedb/1',
            ]
          : isZfs
            ? [
                'tank_backup_01/veeam_immutable_vault        928T  512T  416T  56% /mnt/tank_backup_01/veeam',
                'tank_backup_01/ceph_rbd_nightly             726T  310T  416T  43% /mnt/tank_backup_01/ceph_rbd',
              ]
            : isCephOrZfs
              ? [
                  '/dev/nvme1n1 (ceph-osd.0 bluestore)          15T  9.8T  5.2T  65% /var/lib/ceph/osd/ceph-0',
                  '/dev/nvme2n1 (ceph-osd.1 bluestore)          15T  9.9T  5.1T  66% /var/lib/ceph/osd/ceph-1',
                ]
              : [
                  '10.30.10.55:/fg_llm_datasets_prod            80T   58T   22T  73% /mnt/trident/fg_llm_datasets (nfs4,nconnect=8)',
                  '/dev/mapper/3600a0980383146525a2b516a4b38724d 4.0T  2.6T  1.4T  65% /var/lib/kubelet/pods/pvc-8f92a1b0',
                ]),
        '               total        used        free      shared  buff/cache   available',
        'Mem:           503Gi       184Gi        42Gi       2.1Gi       276Gi       314Gi',
        'Swap:          8.0Gi          0B       8.0Gi',
      ].join('\r\n'),
    };
  }

  return {
    exitCode: 0,
    output: `[demo:${hostOrName}] Executed: ${cmd}\r\nStatus: OK (0 errors, response time 0.4ms). Skriv 'help' för fler demokommandon eller 'simulate-error' för att testa AI-felsökning.`,
  };
}

export class DemoVirtualPty implements IPty {
  public pid: number;
  public cols: number;
  public rows: number;
  public process: string;
  public handleFlowControl = false;

  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();
  private lineBuffer = '';
  private history: string[] = [];
  private historyIdx = -1;
  private killed = false;

  constructor(
    private readonly config: SSHConnectionConfig,
    cols = 100,
    rows = 30
  ) {
    this.pid = 40000 + Math.floor(Math.random() * 9000);
    this.cols = cols;
    this.rows = rows;
    this.process = `demo-ssh:${config.name || config.host}`;

    setTimeout(() => {
      if (!this.killed) {
        this.emitWelcomeBanner();
      }
    }, 30);
  }

  private getPrompt(): string {
    const h = `${this.config.name || ''} ${this.config.host || ''}`.toLowerCase();
    if (h.includes('fas9000')) {
      return '\x1b[1;36mNetApp-DR-Uppsala::>\x1b[0m ';
    }
    if (h.includes('netapp') || h.includes('aff-') || h.includes('10.30.10.1')) {
      return '\x1b[1;36mNetApp-ONTAP-Prod-SE::>\x1b[0m ';
    }
    const user = this.config.username || 'root';
    const host = this.config.name || this.config.host || 'demo-node';
    const sym = user === 'root' || user === 'admin' ? '#' : '$';
    return `\x1b[1;32m${user}@${host}\x1b[0m:\x1b[1;34m~\x1b[0m${sym} `;
  }

  private emitData(text: string): void {
    if (this.killed) return;
    for (const listener of this.dataListeners) {
      listener(text);
    }
  }

  private emitWelcomeBanner(): void {
    const label = this.config.name || this.config.host;
    const h = label.toLowerCase();
    const isOntap = h.includes('netapp') || h.includes('aff-') || h.includes('fas9000');
    const isSg = h.includes('sg-') || h.includes('storagegrid') || h.includes('minio');
    const isCeph = h.includes('ceph') || h.includes('truenas');

    const lines: string[] = [
      '\x1b[1;36m================================================================================\x1b[0m',
    ];
    if (isOntap) {
      lines.push(
        `\x1b[1;37m  NetApp ONTAP 9.15.1P2 Cluster Shell — ${label} (${this.config.host})\x1b[0m`,
        `  Cluster: \x1b[33m${this.config.cluster || 'NetApp-ONTAP-Prod-SE'}\x1b[0m | HA State: \x1b[32mConnected (NVMe-oF Sync OK)\x1b[0m`,
        `  💡 \x1b[36mDemo-tips:\x1b[0m Kör \x1b[33mqos statistics volume latency show\x1b[0m, \x1b[33msnapmirror show\x1b[0m, \x1b[33mstorage aggregate show\x1b[0m,`,
        `     eller skriv \x1b[33msimulate-error\x1b[0m för att trigga knappen \x1b[1;35m✨ Förklara & fixa felet\x1b[0m!`
      );
    } else if (isSg) {
      lines.push(
        `\x1b[1;37m  NetApp StorageGRID 11.8 / S3 Appliance — ${label} (${this.config.host})\x1b[0m`,
        `  Cluster: \x1b[33m${this.config.cluster || 'NetApp-StorageGRID-S3'}\x1b[0m | ILM Policy: \x1b[32mILM-Prod-FabricPool-EC63 (6+3)\x1b[0m`,
        `  💡 \x1b[36mDemo-tips:\x1b[0m Kör \x1b[33mstoragegrid-status\x1b[0m, \x1b[33maws s3 ls\x1b[0m, \x1b[33miostat -xz 1 2\x1b[0m eller \x1b[33msimulate-error\x1b[0m!`
      );
    } else if (isCeph) {
      lines.push(
        `\x1b[1;37m  Ceph Reef 18.2.4 NVMe & TrueNAS OpenZFS — ${label} (${this.config.host})\x1b[0m`,
        `  Cluster: \x1b[33m${this.config.cluster || 'Ceph-NVMe-Block-Pool'}\x1b[0m | Network: \x1b[32mDual 100GbE RoCEv2\x1b[0m`,
        `  💡 \x1b[36mDemo-tips:\x1b[0m Kör \x1b[33mceph -s\x1b[0m, \x1b[33mceph osd df tree\x1b[0m, \x1b[33mzpool status\x1b[0m eller \x1b[33msimulate-error\x1b[0m!`
      );
    } else {
      lines.push(
        `\x1b[1;37m  Ubuntu 24.04.1 LTS (Kubernetes 1.31 + NetApp Astra Trident 24.06) — ${label}\x1b[0m`,
        `  Cluster: \x1b[33m${this.config.cluster || 'K8s-Trident-CSI-Prod'}\x1b[0m | Multipath: \x1b[32mDM-Multipath NVMe/iSCSI + NFSv4.1\x1b[0m`,
        `  💡 \x1b[36mDemo-tips:\x1b[0m Kör \x1b[33mkubectl get pods,pvc -A\x1b[0m, \x1b[33mtridentctl get backend -n trident\x1b[0m, \x1b[33mmultipath -ll\x1b[0m,`,
        `     eller skriv \x1b[33msimulate-error\x1b[0m för att trigga knappen \x1b[1;35m✨ Förklara & fixa felet\x1b[0m!`
      );
    }
    lines.push(
      '\x1b[1;36m================================================================================\x1b[0m\r\n'
    );

    this.emitData(lines.join('\r\n') + this.getPrompt());
  }

  public onData(listener: (e: string) => any): IDisposable {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  public onExit(listener: (e: { exitCode: number; signal?: number }) => any): IDisposable {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  public write(data: string): void {
    if (this.killed) return;

    // Handle AI framed command execution (__SSHS3_START_<id>__ ... __SSHS3_END_<id>__)
    const startMatch = data.match(/__SSHS3_START_([a-zA-Z0-9_-]+)__/);
    if (startMatch && data.includes('__SSHS3_END_')) {
      const markerId = startMatch[1];
      let inner = data;
      // Extract the command between the first printf/echo and __sshs3_ec
      const bashMatch = data.match(
        /__SSHS3_START_[a-zA-Z0-9_-]+__\\n['"]?;\s*([\s\S]*?);\s*__sshs3_ec=\$\?/
      );
      const pwshMatch = data.match(
        /__SSHS3_START_[a-zA-Z0-9_-]+__['"];\s*([\s\S]*?);\s*\$__sshs3_ec/
      );
      if (bashMatch?.[1]) {
        inner = bashMatch[1].trim();
      } else if (pwshMatch?.[1]) {
        inner = pwshMatch[1].trim();
      }
      const res = executeDemoServerCommand(this.config.name || this.config.host, inner);
      this.emitData(
        `\r\n${inner}\r\n__SSHS3_START_${markerId}__\r\n${res.output}\r\n__SSHS3_END_${markerId}__:${res.exitCode}\r\n\x1b]133;D;${res.exitCode}\x07${this.getPrompt()}`
      );
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];

      // Escape sequences (ArrowUp / ArrowDown)
      if (ch === '\x1b' && data[i + 1] === '[') {
        const code = data[i + 2];
        if (code === 'A') {
          // ArrowUp
          if (this.history.length > 0 && this.historyIdx < this.history.length - 1) {
            this.historyIdx++;
            this.replaceLineBuffer(this.history[this.history.length - 1 - this.historyIdx]);
          }
          i += 2;
          continue;
        }
        if (code === 'B') {
          // ArrowDown
          if (this.historyIdx > 0) {
            this.historyIdx--;
            this.replaceLineBuffer(this.history[this.history.length - 1 - this.historyIdx]);
          } else if (this.historyIdx === 0) {
            this.historyIdx = -1;
            this.replaceLineBuffer('');
          }
          i += 2;
          continue;
        }
        i += 2;
        continue;
      }

      if (ch === '\x03') {
        // Ctrl+C
        this.lineBuffer = '';
        this.historyIdx = -1;
        this.emitData('^C\r\n' + this.getPrompt());
        continue;
      }

      if (ch === '\x0c') {
        // Ctrl+L
        this.emitData('\x1b[2J\x1b[H' + this.getPrompt() + this.lineBuffer);
        continue;
      }

      if (ch === '\r' || ch === '\n') {
        const cmd = this.lineBuffer.trim();
        this.lineBuffer = '';
        this.historyIdx = -1;
        this.emitData('\r\n');

        if (cmd === 'clear') {
          this.emitData('\x1b[2J\x1b[H' + this.getPrompt());
          continue;
        }
        if (cmd === 'exit' || cmd === 'logout') {
          this.emitData('logout\r\n');
          this.kill();
          return;
        }

        if (cmd) {
          this.history.push(cmd);
          const result = executeDemoServerCommand(this.config.name || this.config.host, cmd);
          if (result.output) {
            this.emitData(result.output + '\r\n');
          }
          // Emit OSC 133 command finished sequence so TerminalRegistry detects exitCode!
          this.emitData(`\x1b]133;D;${result.exitCode}\x07` + this.getPrompt());
        } else {
          this.emitData(this.getPrompt());
        }
        continue;
      }

      if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          this.emitData('\b \b');
        }
        continue;
      }

      if (ch === '\t') {
        const suggestions = [
          'qos statistics volume latency show',
          'storage aggregate show',
          'volume show',
          'snapmirror show',
          'storagegrid-status',
          'ceph -s',
          'ceph osd df tree',
          'zpool status -v',
          'kubectl get pods,pvc -A',
          'tridentctl get backend -n trident',
          'multipath -ll',
          'simulate-error',
        ];
        const match = suggestions.find((s) => s.startsWith(this.lineBuffer) && s !== this.lineBuffer);
        if (match) {
          this.replaceLineBuffer(match);
        }
        continue;
      }

      if (ch >= ' ') {
        this.lineBuffer += ch;
        this.emitData(ch);
      }
    }
  }

  private replaceLineBuffer(next: string): void {
    const erase = '\b \b'.repeat(this.lineBuffer.length);
    this.lineBuffer = next;
    this.emitData(erase + next);
  }

  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  public clear(): void {
    this.emitData('\x1b[2J\x1b[H' + this.getPrompt());
  }

  public pause(): void {}

  public resume(): void {}

  public kill(_signal?: string): void {
    if (this.killed) return;
    this.killed = true;
    for (const listener of this.exitListeners) {
      listener({ exitCode: 0 });
    }
  }
}
