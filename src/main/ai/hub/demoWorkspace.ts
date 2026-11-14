import type {
  AgentSchedule,
  AgentTask,
  InfraGraphEdge,
  KbDocument,
  McpCatalogPreset,
  McpServerConfig,
  MemoryEntry,
  MissionAgent,
  WorkforceRun,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import type { S3Config } from "../../../shared/types/storage";
import type { Snippet } from "../../../shared/types/snippets";
import { isDemoMode } from "../../demo/demoMode";
import {
  getDefaultAgents,
  getDefaultKbDocuments,
  getDefaultSkillsAndMemories,
  getDefaultSnippets,
} from "./builtins";

// Demo mode is decided once at launch and never changes at runtime; the flag lives in
// demo/demoMode.ts. Re-exported because many modules import it from here.
export { isDemoMode };

// The getBuiltin* functions below decide what ships built in, per mode: these demo fixtures only in demo
// mode, otherwise the neutral defaults of builtins.ts.

const now = Date.now();
const min = 60_000;

const initialDemoServers: WorkspaceServerSummary[] = [
  // ─── Cluster 1: NetApp-ONTAP-Prod-SE (All-Flash SAN/NAS & DR) ──────────
  {
    id: "demo-netapp-aff-a800-01a",
    name: "netapp-aff-a800-01a",
    host: "10.30.10.11",
    port: 22,
    username: "admin",
    folder: "NetApp ONTAP / Stockholm DC1",
    group: "NetApp ONTAP / Stockholm DC1",
    cluster: "NetApp-ONTAP-Prod-SE",
    nodeRole: "ontap-ha-node-a",
    role: "storage-controller",
    description:
      "NetApp AFF A800 all-flash HA node A (ONTAP 9.15.1) in Stockholm DC1. Owns aggr1_nvme_prod (220 TB NVMe) and serves the SVMs svm-prod-nfs (NFSv4.1) and svm-prod-iscsi (iSCSI/NVMe-oF), plus FabricPool S3 tiering to StorageGRID.",
    tags: ["netapp", "ontap-9.15", "aff-a800", "nvme-of", "nfsv4.1", "fabricpool", "prod"],
    shared: true,
    updatedAt: new Date(now - 8 * min).toISOString(),
    updatedBy: "erik@acme.se",
  },
  {
    id: "demo-netapp-aff-a800-01b",
    name: "netapp-aff-a800-01b",
    host: "10.30.10.12",
    port: 22,
    username: "admin",
    folder: "NetApp ONTAP / Stockholm DC1",
    group: "NetApp ONTAP / Stockholm DC1",
    cluster: "NetApp-ONTAP-Prod-SE",
    nodeRole: "ontap-ha-node-b",
    role: "storage-controller",
    description:
      "NetApp AFF A800 all-flash HA partner B (ONTAP 9.15.1). Owns aggr2_nvme_db (180 TB NVMe) for PostgreSQL/Oracle LUNs, FlexGroup volumes for AI training, and synchronous MetroCluster/SnapMirror replication.",
    tags: ["netapp", "ontap-9.15", "aff-a800", "ha-pair", "flexgroup", "iscsi", "prod"],
    shared: true,
    updatedAt: new Date(now - 19 * min).toISOString(),
    updatedBy: "sara@acme.se",
  },
  {
    id: "demo-netapp-fas9000-dr-01",
    name: "netapp-fas9000-dr-01",
    host: "10.30.20.11",
    port: 22,
    username: "admin",
    folder: "NetApp ONTAP / Stockholm DC1",
    group: "NetApp ONTAP / Stockholm DC1",
    cluster: "NetApp-ONTAP-Prod-SE",
    nodeRole: "snapmirror-snapvault-dr",
    role: "storage-controller",
    description:
      "NetApp FAS9000 hybrid-flash DR and SnapVault cluster in Uppsala DC2 (1.6 PB NLSAS + NVMe FlashPool). Receives XDP SnapMirror every 15 minutes from the AFF A800, with SnapLock Compliance against ransomware.",
    tags: ["netapp", "fas9000", "snapmirror", "snapvault", "snaplock", "dr-dc2"],
    shared: true,
    updatedAt: new Date(now - 34 * min).toISOString(),
    updatedBy: "erik@acme.se",
  },
  {
    id: "demo-ontap-aiq-um-01",
    name: "ontap-aiq-um-01",
    host: "10.30.10.25",
    port: 22,
    username: "maint",
    folder: "NetApp ONTAP / Stockholm DC1",
    group: "NetApp ONTAP / Stockholm DC1",
    cluster: "NetApp-ONTAP-Prod-SE",
    nodeRole: "active-iq-harvest",
    role: "monitoring",
    description:
      "NetApp Active IQ Unified Manager 9.14 + NetApp Harvest 24.05 + Prometheus/Grafana for real-time metrics on ONTAP IOPS, QoS latency, WAFL NVRAM and volume growth.",
    tags: ["active-iq", "netapp-harvest", "prometheus", "grafana", "qos-monitoring"],
    shared: true,
    updatedAt: new Date(now - 52 * min).toISOString(),
    updatedBy: "linnea@acme.se",
  },

  // ─── Cluster 2: NetApp-StorageGRID-S3 (Enterprise Object Storage) ──────
  {
    id: "demo-sg-admin-primary-01",
    name: "sg-admin-primary-01",
    host: "10.30.30.10",
    port: 22,
    username: "admin",
    folder: "Object Storage / StorageGRID & S3",
    group: "Object Storage / StorageGRID & S3",
    cluster: "NetApp-StorageGRID-S3",
    nodeRole: "primary-admin-loadbalancer",
    role: "s3-gateway",
    description:
      "NetApp StorageGRID 11.8 primary admin node and high-availability load balancer (S3 HTTPS :10443). Manages the ILM lifecycle rules, S3 Object Lock (WORM), the S3 buckets and the FabricPool connection from ONTAP.",
    tags: ["storagegrid", "netapp-s3", "ilm", "object-lock", "load-balancer", "prod"],
    shared: true,
    updatedAt: new Date(now - 26 * min).toISOString(),
    updatedBy: "sara@acme.se",
  },
  {
    id: "demo-sg-sn-nvme-01",
    name: "sg-sn-nvme-01",
    host: "10.30.30.21",
    port: 22,
    username: "root",
    folder: "Object Storage / StorageGRID & S3",
    group: "Object Storage / StorageGRID & S3",
    cluster: "NetApp-StorageGRID-S3",
    nodeRole: "storage-node-dc1-01",
    role: "object-storage",
    description:
      "NetApp StorageGRID SG6060 storage node 01 (Stockholm DC1): 60 drives + NVMe metadata cache. Runs RangedDB and geo-distributed erasure coding (6+3) across Stockholm and Uppsala.",
    tags: ["storagegrid", "sg6060", "erasure-coding", "s3-storage-node", "dc1"],
    shared: true,
    updatedAt: new Date(now - 68 * min).toISOString(),
    updatedBy: "erik@acme.se",
  },
  {
    id: "demo-sg-sn-nvme-02",
    name: "sg-sn-nvme-02",
    host: "10.30.30.22",
    port: 22,
    username: "root",
    folder: "Object Storage / StorageGRID & S3",
    group: "Object Storage / StorageGRID & S3",
    cluster: "NetApp-StorageGRID-S3",
    nodeRole: "storage-node-dc1-02",
    role: "object-storage",
    description:
      "NetApp StorageGRID SG6060 storage node 02 (Stockholm DC1). Handles S3 multipart uploads for pgBackRest, Loki log segments and ONTAP FabricPool cold blocks.",
    tags: ["storagegrid", "sg6060", "s3-multipart", "fabricpool-target", "dc1"],
    shared: true,
    updatedAt: new Date(now - 90 * min).toISOString(),
    updatedBy: "sara@acme.se",
  },
  {
    id: "demo-minio-aistor-edge-01",
    name: "minio-aistor-edge-01",
    host: "10.30.30.40",
    port: 22,
    username: "ubuntu",
    folder: "Object Storage / StorageGRID & S3",
    group: "Object Storage / StorageGRID & S3",
    cluster: "NetApp-StorageGRID-S3",
    nodeRole: "nvme-s3-tier-cache",
    role: "object-storage",
    description:
      "MinIO AIStor all-NVMe S3 node (4x 100GbE RDMA) for fast reads of LLM checkpoints and Parquet datasets, with automatic tiering down to NetApp StorageGRID.",
    tags: ["minio", "s3", "nvme", "100gbe", "ai-checkpoints"],
    shared: true,
    updatedAt: new Date(now - 115 * min).toISOString(),
    updatedBy: "jacob",
  },

  // ─── Cluster 3: Ceph-NVMe-Block-Pool (Ceph Reef & TrueNAS ZFS) ─────────
  {
    id: "demo-ceph-mon-mgr-01",
    name: "ceph-mon-mgr-01",
    host: "10.30.40.10",
    port: 22,
    username: "cephadm",
    folder: "Ceph & ZFS / Block & Backup",
    group: "Ceph & ZFS / Block & Backup",
    cluster: "Ceph-NVMe-Block-Pool",
    nodeRole: "ceph-mon-mgr-rgw",
    role: "ceph-monitor",
    description:
      "Ceph Reef (18.2.4) monitor, active manager and RADOS Gateway (RGW). Manages the 420 TB NVMe RBD block pool for KVM/OpenStack and Rook-Ceph CSI, with CRUSH rules per rack.",
    tags: ["ceph-reef", "rbd", "radosgw", "crush-map", "nvme-pool"],
    shared: true,
    updatedAt: new Date(now - 42 * min).toISOString(),
    updatedBy: "linnea@acme.se",
  },
  {
    id: "demo-ceph-osd-nvme-01",
    name: "ceph-osd-nvme-01",
    host: "10.30.40.21",
    port: 22,
    username: "cephadm",
    folder: "Ceph & ZFS / Block & Backup",
    group: "Ceph & ZFS / Block & Backup",
    cluster: "Ceph-NVMe-Block-Pool",
    nodeRole: "bluestore-osd-node",
    role: "ceph-osd",
    description:
      "Ceph BlueStore OSD node 01 (16x 15.36TB Gen5 NVMe, osd.0–osd.15) with a dual 100GbE RoCEv2 cluster network and dedicated RocksDB WAL/DB partitions.",
    tags: ["ceph-osd", "bluestore", "gen5-nvme", "rocev2", "100gbe"],
    shared: true,
    updatedAt: new Date(now - 130 * min).toISOString(),
    updatedBy: "linnea@acme.se",
  },
  {
    id: "demo-truenas-zfs-vault-01",
    name: "truenas-zfs-vault-01",
    host: "10.30.40.50",
    port: 22,
    username: "truenas_admin",
    folder: "Ceph & ZFS / Block & Backup",
    group: "Ceph & ZFS / Block & Backup",
    cluster: "Ceph-NVMe-Block-Pool",
    nodeRole: "zfs-immutable-vault",
    role: "zfs-storage",
    description:
      "TrueNAS Enterprise ZFS storage node (zpool: tank_backup_01, 1.4 PB RAIDZ3 + Optane SLOG and 2TB L2ARC) for immutable ZFS snapshots, zfs send/recv and Restic/Veeam archives.",
    tags: ["truenas", "openzfs", "raidz3", "optane-slog", "zfs-send", "backup"],
    shared: true,
    updatedAt: new Date(now - 165 * min).toISOString(),
    updatedBy: "jacob",
  },

  // ─── Cluster 4: K8s-Trident-CSI-Prod (Kubernetes + NetApp Trident CSI) ─
  {
    id: "demo-k8s-storage-cp-01",
    name: "k8s-storage-cp-01",
    host: "10.30.50.10",
    port: 22,
    username: "ubuntu",
    folder: "Kubernetes & Trident CSI",
    group: "Kubernetes & Trident CSI",
    cluster: "K8s-Trident-CSI-Prod",
    nodeRole: "k8s-control-plane-trident",
    role: "k8s",
    description:
      "Kubernetes 1.31 control plane with NetApp Astra Trident CSI 24.06 (namespace: trident). Provisions PVCs dynamically on ontap-nas (NFSv4.1), ontap-san (iSCSI/NVMe-oF) and ontap-nas-flexgroup.",
    tags: ["k8s", "astra-trident", "csi-driver", "ontap-nas", "ontap-san", "volume-snapshots"],
    shared: true,
    updatedAt: new Date(now - 22 * min).toISOString(),
    updatedBy: "erik@acme.se",
  },
  {
    id: "demo-k8s-gpu-io-worker-01",
    name: "k8s-gpu-io-worker-01",
    host: "10.30.50.21",
    port: 22,
    username: "ubuntu",
    folder: "Kubernetes & Trident CSI",
    group: "Kubernetes & Trident CSI",
    cluster: "K8s-Trident-CSI-Prod",
    nodeRole: "nvmeof-nfsv4-worker",
    role: "k8s",
    description:
      "Kubernetes GPU and high-IOPS worker node. Mounts NetApp FlexGroup volumes with NFSv4.1 nconnect=8, pNFS/session trunking and DM-Multipath iSCSI/NVMe-oF.",
    tags: ["k8s-worker", "nconnect", "dm-multipath", "iscsi-initiator", "nvme-tcp"],
    shared: true,
    updatedAt: new Date(now - 75 * min).toISOString(),
    updatedBy: "jacob",
  },

  // ─── Cluster 5: SAN-Fabric-Mgmt (Storage Jump-Host & SAN Tooling) ──────
  {
    id: "demo-san-bastion-jump-01",
    name: "san-bastion-jump-01",
    host: "10.30.99.10",
    port: 22,
    username: "jacob",
    folder: "SAN Fabric & Bastion",
    group: "SAN Fabric & Bastion",
    cluster: "SAN-Fabric-Mgmt",
    nodeRole: "storage-jump-host",
    role: "bastion",
    description:
      "Dedicated jump host for storage engineering, with NetApp ONTAP Ansible playbooks, tridentctl, s3cmd, aws-cli, rclone, fio benchmarks and Brocade SAN zoning scripts.",
    tags: ["bastion", "tridentctl", "fio", "ansible-ontap", "s3cmd", "brocade-san"],
    shared: true,
    updatedAt: new Date(now - 210 * min).toISOString(),
    updatedBy: "jacob",
  },
];

const initialDemoS3Profiles: S3Config[] = [
  {
    id: "demo-s3-storagegrid-prod",
    name: "NetApp StorageGRID — Prod FabricPool & S3",
    endpoint: "https://s3-dc1.storage.acme.se:10443",
    region: "eu-north-1",
    accessKeyId: "SG_PROD_AKIA90210DEMO",
    secretAccessKey: "demo-secret-not-shared", // pragma: allowlist secret
    forcePathStyle: true,
    initialPath: "ontap-fabricpool-tier",
    group: "Object Storage / StorageGRID & S3",
    updatedAt: new Date(now - 25 * min).toISOString(),
  },
  {
    id: "demo-s3-ontap-svm-s3",
    name: "NetApp ONTAP S3 — svm-prod-s3 (All-Flash NVMe)",
    endpoint: "https://10.30.10.15",
    region: "eu-north-1",
    accessKeyId: "ONTAP_S3_AKIA4411DEMO",
    secretAccessKey: "demo-secret-not-shared", // pragma: allowlist secret
    forcePathStyle: true,
    initialPath: "ai-datasets-nvme",
    group: "NetApp ONTAP / Stockholm DC1",
    updatedAt: new Date(now - 40 * min).toISOString(),
  },
  {
    id: "demo-s3-ceph-rgw-backup",
    name: "Ceph RADOSGW — Immutable Veeam & pgBackRest Vault",
    endpoint: "https://rgw.ceph.acme.se",
    region: "eu-north-1",
    accessKeyId: "CEPH_RGW_AKIA7788DEMO",
    secretAccessKey: "demo-secret-not-shared", // pragma: allowlist secret
    forcePathStyle: true,
    initialPath: "veeam-immutable-vault",
    group: "Ceph & ZFS / Block & Backup",
    updatedAt: new Date(now - 85 * min).toISOString(),
  },
  {
    id: "demo-s3-minio-aistor",
    name: "MinIO AIStor — High-Speed LLM Checkpoints",
    endpoint: "https://10.30.30.40:9000",
    region: "us-east-1",
    accessKeyId: "MINIO_AISTOR_DEMO_KEY",
    secretAccessKey: "demo-secret-not-shared", // pragma: allowlist secret
    forcePathStyle: true,
    initialPath: "llm-checkpoints-prod",
    group: "Object Storage / StorageGRID & S3",
    updatedAt: new Date(now - 110 * min).toISOString(),
  },
];

const initialDemoActivity: WorkspaceActivityEvent[] = [
  {
    id: "demo-act-ontap-vol-grow",
    profileId: "demo-netapp-aff-a800-01a",
    targetLabel: "netapp-aff-a800-01a",
    actor: "erik@acme.se",
    kind: "command",
    summary:
      "Grew the ONTAP FlexVol 'vol_k8s_pvc_prod' in svm-prod-nfs from 12TB to 16TB and turned on FabricPool tiering (snapshot-only, min-cooling-days 14)",
    detail:
      "volume modify -vserver svm-prod-nfs -volume vol_k8s_pvc_prod -size 16TB -autosize-mode grow_shrink -max-autosize 24TB -tiering-policy snapshot-only -tiering-minimum-cooling-days 14",
    at: now - 8 * min,
  },
  {
    id: "demo-act-ontap-qos-ai",
    profileId: "demo-netapp-aff-a800-01b",
    targetLabel: "netapp-aff-a800-01b",
    actor: "sara@acme.se (AI)",
    kind: "ai-action",
    summary:
      "AI diagnostics found a noisy neighbor, 'vol_ai_scratch_03' (48 200 IOPS read peak), and set the QoS policy 'pg-batch-ceiling' (max 15 000 IOPS); latency on vol_pg_prod_db01 in aggr2_nvme_db fell from 1.88 ms to 0.32 ms",
    detail:
      "qos statistics volume latency show -iterations 3 && volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling",
    at: now - 19 * min,
  },
  {
    id: "demo-act-trident-csi",
    profileId: "demo-k8s-storage-cp-01",
    targetLabel: "k8s-storage-cp-01",
    actor: "erik@acme.se",
    kind: "deploy",
    summary:
      "Updated the NetApp Astra Trident backend 'tbc-ontap-nas-flexgroup-ai' and rolled out the StorageClass 'ontap-flexgroup-ai' with mountOptions: nfsvers=4.1,nconnect=8,noatime",
    detail:
      "kubectl apply -f /etc/trident/storageclass-ontap-flexgroup-ai.yaml && tridentctl get backend -n trident",
    at: now - 22 * min,
  },
  {
    id: "demo-act-storagegrid-ilm",
    profileId: "demo-sg-admin-primary-01",
    targetLabel: "sg-admin-primary-01",
    actor: "sara@acme.se",
    kind: "config-edit",
    summary:
      "Updated the StorageGRID ILM policy 'ILM-Prod-FabricPool-EC63' for erasure coding 6+3 across DC1/DC2 and verified S3 Object Lock compliance on the bucket 'ontap-fabricpool-tier'",
    detail:
      "storagegrid-cli ilm policy validate --policy ILM-Prod-FabricPool-EC63 && aws --endpoint-url https://localhost:10443 s3api get-object-lock-configuration --bucket ontap-fabricpool-tier",
    at: now - 26 * min,
  },
  {
    id: "demo-act-snapmirror-resync",
    profileId: "demo-netapp-fas9000-dr-01",
    targetLabel: "netapp-fas9000-dr-01",
    actor: "erik@acme.se",
    kind: "service",
    summary:
      "Verified SnapMirror XDP replication to Uppsala DC2 (netapp-fas9000-dr-01): all 28 relationships are 'Snapmirrored' with lag-time under 4 minutes and SnapLock WORM retention active",
    detail:
      "snapmirror show -fields state,status,lag-time,healthy -destination-vserver svm-dr-uppsala",
    at: now - 34 * min,
  },
  {
    id: "demo-act-ceph-scrub",
    profileId: "demo-ceph-mon-mgr-01",
    targetLabel: "ceph-mon-mgr-01",
    actor: "linnea@acme.se",
    kind: "command",
    summary:
      "Fixed the Ceph HEALTH_WARN (2 PGs not deep-scrubbed in time) on the pool 'rbd-nvme-prod' and set osd_max_backfills=2 for office hours",
    detail:
      "ceph status && ceph config set osd osd_max_backfills 2 && ceph pg deep-scrub 4.1a",
    at: now - 42 * min,
  },
  {
    id: "demo-act-multipath-k8s",
    profileId: "demo-k8s-gpu-io-worker-01",
    targetLabel: "k8s-gpu-io-worker-01",
    actor: "jacob",
    kind: "config-edit",
    summary:
      "Updated /etc/multipath.conf for the NetApp LUNs (rr_min_io_rq 1) and reloaded multipathd",
    detail:
      "sudo vim /etc/multipath.conf && sudo systemctl reload multipathd && sudo multipath -ll",
    at: now - 75 * min,
  },
  {
    id: "demo-act-zfs-send",
    profileId: "demo-truenas-zfs-vault-01",
    targetLabel: "truenas-zfs-vault-01",
    actor: "jacob (AI)",
    kind: "ai-action",
    summary:
      "Checked ZFS pool health on 'tank_backup_01' (ONLINE, 0 errors, 71% cap, compression ratio 2.41x LZ4) and removed expired temporary snapshots older than 90 days",
    detail:
      "zpool status tank_backup_01 && zfs list -t volume,filesystem -o name,used,avail,compressratio,mountpoint",
    at: now - 165 * min,
  },
];

const initialDemoMemories: MemoryEntry[] = [
  // ─── Shared Workspace Memories (Architecture & State) ─────────────────
  {
    id: "demo-mem-ontap-topology",
    kind: "memory",
    tier: "core",
    updatedCount: 5,
    scope: "workspace",
    title: "NetApp AFF A800 (NetApp-ONTAP-Prod-SE) — aggregates, SVMs and LIF topology",
    text: [
      "The cluster `NetApp-ONTAP-Prod-SE` (ONTAP 9.15.1) in Stockholm DC1 is the HA pair `netapp-aff-a800-01a` (10.30.10.11) and `netapp-aff-a800-01b` (10.30.10.12).",
      "- `aggr1_nvme_prod` (node A, 220 TB NVMe RAID-TEC): primary storage for `svm-prod-nfs` (Kubernetes Astra Trident NFSv4.1 PVCs and shared file systems).",
      "- `aggr2_nvme_db` (node B, 180 TB NVMe RAID-TEC): low-latency storage (< 0.5 ms) for `svm-prod-iscsi` (PostgreSQL/Oracle iSCSI and NVMe/TCP namespaces) and `svm-prod-s3`.",
      "- Cold snapshots and inactive blocks move automatically through **NetApp FabricPool** to `NetApp-StorageGRID-S3` (`ontap-fabricpool-tier`) after 14 days.",
    ].join("\n"),
    author: "erik@acme.se",
    updatedAt: now - 8 * min,
  },
  {
    id: "demo-mem-snapmirror-dr",
    kind: "memory",
    tier: "core",
    updatedCount: 3,
    scope: "workspace",
    title: "NetApp SnapMirror XDP and SnapLock ransomware protection (Uppsala DC2)",
    text: [
      "All production volumes on `netapp-aff-a800-01a/01b` replicate with **SnapMirror XDP** every 15 minutes to `netapp-fas9000-dr-01` (10.30.20.11, SVM `svm-dr-uppsala`).",
      "- The snapshot policy `pol-prod-ransomware-safe` takes hourly snapshots with **Tamperproof Snapshot Locking** kept for 14 days, and daily SnapVault copies kept for 90 days.",
      "- On an alert for high `lag-time` (> 30 min): check the intercluster LIFs `ic-dc1-01a` / `ic-dc2-01a` on VLAN 3090 (MTU 9000 jumbo frames).",
    ].join("\n"),
    author: "erik@acme.se",
    updatedAt: now - 34 * min,
  },
  {
    id: "demo-mem-storagegrid-s3",
    kind: "memory",
    tier: "archival",
    updatedCount: 2,
    scope: "workspace",
    title: "NetApp StorageGRID 11.8 and MinIO AIStor — S3 object storage and ILM",
    text: [
      "The object storage cluster `NetApp-StorageGRID-S3` is managed through `sg-admin-primary-01` (10.30.30.10, S3 endpoint `https://s3-dc1.storage.acme.se:10443`), with the storage nodes `sg-sn-nvme-01` and `sg-sn-nvme-02`.",
      "- The ILM policy `ILM-Prod-FabricPool-EC63` uses erasure coding 6+3 across DC1/DC2.",
      "- AI/ML training jobs use `minio-aistor-edge-01` (10.30.30.40:9000, bucket `llm-checkpoints-prod`) as an NVMe cache with automatic tiering to StorageGRID.",
    ].join("\n"),
    author: "sara@acme.se",
    updatedAt: now - 26 * min,
  },
  {
    id: "demo-mem-trident-csi",
    kind: "memory",
    tier: "core",
    updatedCount: 4,
    scope: "workspace",
    title: "Kubernetes Astra Trident CSI 24.06 — StorageClasses and multipath",
    text: [
      "The Kubernetes cluster `K8s-Trident-CSI-Prod` (`k8s-storage-cp-01`, `k8s-gpu-io-worker-01`) uses NetApp Astra Trident in the namespace `trident`:",
      "- `ontap-nas-premium`: the `ontap-nas` driver on `svm-prod-nfs` (NFSv4.1, `nconnect=8`).",
      "- `ontap-flexgroup-ai`: `ontap-nas-flexgroup` for parallel high-capacity I/O from the GPU workers.",
      "- `ontap-san-nvme`: the `ontap-san` driver with iSCSI / NVMe-oF and ALUA `group_by_prio` in `/etc/multipath.conf`.",
    ].join("\n"),
    author: "jacob",
    updatedAt: now - 22 * min,
  },
  {
    id: "demo-mem-ceph-truenas",
    kind: "memory",
    tier: "episodic",
    updatedCount: 2,
    scope: "workspace",
    title: "Ceph Reef NVMe pool and TrueNAS ZFS immutable backup",
    text: [
      "The cluster `Ceph-NVMe-Block-Pool` (`ceph-mon-mgr-01` 10.30.40.10, `ceph-osd-nvme-01` 10.30.40.21) provides RBD block storage (`rbd-nvme-prod`, 3 replicas, min_size 2) over 100GbE RoCEv2.",
      "`truenas-zfs-vault-01` (10.30.40.50) holds the ZFS pool `tank_backup_01` (1.4 PB RAIDZ3 + Optane SLOG) for nightly ZFS replication and Restic/Veeam archives.",
    ].join("\n"),
    author: "linnea@acme.se",
    updatedAt: now - 42 * min,
  },

  // ─── Shared Workspace Skills / Storage Runbooks ───────────────────────
  {
    id: "demo-skill-ontap-latency",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: troubleshoot high I/O latency in NetApp ONTAP (QoS, WAFL and NVRAM)",
    text: [
      "1. Find which ONTAP component causes the latency (Network, Cluster-Interconnect, Disk, WAFL or QoS ceiling):",
      "   `qos statistics volume latency show -iterations 5 -rows 15`",
      "2. Find the 'noisy neighbor' volumes with the highest IOPS/throughput:",
      "   `qos statistics volume performance show -iterations 5`",
      "3. Check the aggregate's disk utilization and the CPU/WAFL load per HA node:",
      "   `system node run -node netapp-aff-a800-01* -command sysstat -x 1`",
      "4. Throttle a noisy batch or scratch volume right away with a QoS policy:",
      "   `volume modify -vserver <svm> -volume <vol> -qos-policy-group pg-batch-ceiling`",
    ].join("\n"),
    author: "sara@acme.se",
    updatedAt: now - 19 * min,
  },
  {
    id: "demo-skill-snapmirror-lag",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: NetApp SnapMirror lag, Broken-off resync and DR verification",
    text: [
      "1. List all SnapMirror relationships with `lag-time > 30m` or `healthy: false`:",
      "   `snapmirror show -healthy false -fields source-path,destination-path,state,status,lag-time,last-transfer-error`",
      "2. Verify that the intercluster LIFs reach each other with MTU 9000:",
      "   `cluster peer ping -aca true` and `network interface show -role intercluster`",
      "3. Start a manual incremental update or a resync:",
      "   `snapmirror update -destination-path svm-dr-uppsala:<vol_dest>`",
      "   (If `Broken-off`: `snapmirror resync -destination-path svm-dr-uppsala:<vol_dest>`)",
    ].join("\n"),
    author: "erik@acme.se",
    updatedAt: now - 34 * min,
  },
  {
    id: "demo-skill-trident-pvc",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: troubleshoot a Kubernetes Astra Trident PVC in Pending / AttachError",
    text: [
      "1. Inspect the PVC events and the Trident controller's logs on `k8s-storage-cp-01`:",
      "   `kubectl describe pvc <pvc-name> -n <ns>`",
      "   `tridentctl logs -n trident -l trident-operator`",
      "2. Check that all ONTAP backends in Trident are `online`:",
      "   `tridentctl get backend -n trident`",
      "3. On an iSCSI `Multi-Attach` or `AttachError` on `k8s-gpu-io-worker-01`, check `iscsid` and multipath:",
      "   `sudo iscsiadm -m session -P 3 && sudo multipath -ll`",
      "4. On an NFSv4.1 mount timeout, check the export policy in ONTAP:",
      "   `vserver export-policy rule show -vserver svm-prod-nfs -policyname trid_export_prod`",
    ].join("\n"),
    author: "erik@acme.se",
    updatedAt: now - 22 * min,
  },
  {
    id: "demo-skill-storagegrid-ilm",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: NetApp StorageGRID S3 health check, ILM queue and FabricPool tiering",
    text: [
      "1. On `sg-admin-primary-01`, check node status and active alerts in StorageGRID:",
      "   `storagegrid-status` and `curl -sk https://localhost:10443/health`",
      "2. From ONTAP (`netapp-aff-a800-01a`), check that the FabricPool object store target is `available`:",
      "   `storage aggregate object-store show -fields object-store-name,availability,unavailable-reason`",
      "3. Test the S3 response time and list the buckets from `san-bastion-jump-01`:",
      "   `aws --endpoint-url https://s3-dc1.storage.acme.se:10443 s3 ls`",
    ].join("\n"),
    author: "sara@acme.se",
    updatedAt: now - 26 * min,
  },
  {
    id: "demo-skill-ceph-health",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: Ceph HEALTH_WARN (slow ops, nearfull OSD and PG scrubbing)",
    text: [
      "1. Check cluster health and the detailed warnings on `ceph-mon-mgr-01`:",
      "   `ceph status && ceph health detail`",
      "2. List OSD utilization and find unbalanced NVMe drives:",
      "   `ceph osd df tree` and `ceph df detail`",
      "3. On `SLOW_OPS`: find the blocked OSDs and check NVMe latency:",
      "   `ceph daemon osd.<id> dump_historic_slow_ops`",
      "4. If rebalancing affects production I/O, slow the backfill rate for the time being:",
      "   `ceph config set osd osd_max_backfills 1 && ceph config set osd osd_recovery_max_active 1`",
    ].join("\n"),
    author: "linnea@acme.se",
    updatedAt: now - 42 * min,
  },
  {
    id: "builtin-skill-linux-use-triage",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: Linux SRE incident and performance triage (USE method)",
    text: [
      "1. A quick 60-second USE overview (Utilization, Saturation, Errors):",
      "   `uptime && dmesg -T | tail -n 20 && vmstat 1 3 && iostat -xz 1 2`",
      "2. Find systemd services that crashed or restarted:",
      "   `systemctl --failed && journalctl -p err..alert -n 40 --no-pager`",
      "3. Check listening ports and TCP queues:",
      "   `ss -tulnp && ss -s`",
      "4. Check disk space, inodes and the largest log directories:",
      "   `df -hT && df -i && sudo du -xhd1 /var/log | sort -hr | head -n 10`",
    ].join("\n"),
    author: "sshs3-stdlib",
    updatedAt: now - 55 * min,
  },
  {
    id: "builtin-mem-sre-golden-rules",
    kind: "memory",
    tier: "core",
    updatedCount: 1,
    scope: "workspace",
    title: "SRE safety principles: read-only first, back up before a change, verify after",
    text: [
      "- Always run non-destructive diagnostic commands (read-only) to confirm the current state before you propose commands that change state.",
      "- Always back up a configuration file (`cp -a file file.bak.$(date +%F)`) before you edit it, and check the syntax (`nginx -t`, `sshd -t`, `multipath -t`) before a reload.",
      "- Always check service and cluster health after every change.",
    ].join("\n"),
    author: "sshs3-stdlib",
    updatedAt: now - 60 * min,
  },
];

const initialDemoSchedules: AgentSchedule[] = [
  {
    id: "demo-sched-ontap-health",
    title: "NetApp ONTAP aggregates, volume capacity and QoS latency (every 30 min)",
    prompt:
      "Check storage failover status, aggregates more than 80% full, volumes close to their quota, and whether any SVM volume has QoS latency above 2 ms on @netapp-aff-a800-01a and @netapp-aff-a800-01b.",
    profileId: "demo-netapp-aff-a800-01a",
    shell: "bash",
    intervalMinutes: 30,
    nextRunAt: now + 18 * min,
    enabled: true,
    mode: "assisted",
    model: "gpt-6.1-sol",
    provider: "openai-codex",
    maxCommands: 10,
    maxMinutes: 10,
    lastStatus: "completed",
  },
  {
    id: "demo-sched-snapmirror-sla",
    title: "SnapMirror XDP RPO and SnapLock verification (every hour)",
    prompt:
      "On @netapp-fas9000-dr-01, verify that all SnapMirror relationships have healthy=true and lag-time under 30 minutes. Report deviations in the team's activity log.",
    profileId: "demo-netapp-fas9000-dr-01",
    shell: "bash",
    intervalMinutes: 60,
    nextRunAt: now + 42 * min,
    enabled: true,
    mode: "assisted",
    model: "gpt-6.1-sol",
    provider: "openai-codex",
    maxCommands: 8,
    maxMinutes: 10,
    lastStatus: "completed",
  },
  {
    id: "demo-sched-storagegrid-ceph",
    title: "StorageGRID S3 FabricPool and Ceph NVMe pool health (every 2 hours)",
    prompt:
      "Check S3 endpoint status and the ILM queues on @sg-admin-primary-01, and `ceph health detail` and `ceph df` on @ceph-mon-mgr-01.",
    profileId: "demo-ceph-mon-mgr-01",
    shell: "bash",
    intervalMinutes: 120,
    nextRunAt: now + 85 * min,
    enabled: true,
    mode: "assisted",
    model: "gpt-6.1-sol",
    provider: "openai-codex",
    maxCommands: 10,
    maxMinutes: 10,
    lastStatus: "completed",
  },
];

const initialDemoSnippets: Snippet[] = [
  {
    id: "demo-snip-ontap-latency",
    name: "ONTAP: top volume latency (QoS)",
    command: "qos statistics volume latency show -iterations 5 -rows 15",
  },
  {
    id: "demo-snip-ontap-aggr-vol",
    name: "ONTAP: aggregate and FlexVol capacity (>75%)",
    command:
      "storage aggregate show -fields size,usedsize,percent-used,state && volume show -percent-used >75 -fields vserver,volume,size,avail,percent-used,tiering-policy",
  },
  {
    id: "demo-snip-ontap-snapmirror",
    name: "ONTAP: SnapMirror health and lag-time",
    command:
      "snapmirror show -fields source-path,destination-path,state,status,healthy,lag-time",
  },
  {
    id: "demo-snip-trident-status",
    name: "K8s Trident CSI: backends, StorageClasses and PVCs",
    command:
      "tridentctl get backend -n trident && kubectl get sc,pvc -A -o wide",
  },
  {
    id: "demo-snip-ceph-health",
    name: "Ceph: cluster status, OSD utilization and pool usage",
    command: "ceph -s && ceph osd df tree && ceph df detail",
  },
  {
    id: "demo-snip-zfs-status",
    name: "TrueNAS ZFS: pool health and datasets",
    command:
      "zpool status -v && zfs list -o name,used,avail,refer,compressratio,mountpoint",
  },
  {
    id: "builtin-snip-linux-use-triage",
    name: "Linux SRE: 60-second USE performance triage (CPU/memory/IO)",
    command:
      "uptime && free -h && vmstat 1 3 && iostat -xz 1 2 && dmesg -T | tail -n 15",
  },
  {
    id: "builtin-snip-systemd-failed",
    name: "Linux SRE: failed systemd services and recent critical logs",
    command:
      "systemctl --failed --no-pager && journalctl -p err..alert -n 30 --no-pager",
  },
  {
    id: "builtin-snip-net-ports",
    name: "Network and security: listening ports and established TCP sessions",
    command: "ss -tulnp && ss -tan state established | head -n 30",
  },
  {
    id: "builtin-snip-disk-inodes",
    name: "Storage: disk space, inodes and the 10 largest directories in /var",
    command:
      "df -hT -x tmpfs -x devtmpfs && df -i -x tmpfs && sudo du -xhd1 /var | sort -hr | head -n 10",
  },
  {
    id: "builtin-snip-k8s-events",
    name: "Kubernetes: pods not Running and the latest events",
    command:
      "kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded && kubectl get events -A --sort-by='.lastTimestamp' | tail -n 25",
  },
  {
    id: "builtin-snip-docker-health",
    name: "Containers: Docker status and resource usage",
    command:
      "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}' && docker stats --no-stream",
  },
];

const demoServersStore = new Map<string, WorkspaceServerSummary>(
  initialDemoServers.map((s) => [s.id, { ...s }]),
);
const demoActivityStore: WorkspaceActivityEvent[] = [...initialDemoActivity];
const demoMemoriesStore: MemoryEntry[] = [...initialDemoMemories];

export function getDemoServers(): WorkspaceServerSummary[] {
  return Array.from(demoServersStore.values());
}

export function getDemoS3Profiles(): S3Config[] {
  return initialDemoS3Profiles.map((s) => ({ ...s }));
}

export function getDemoSchedules(): AgentSchedule[] {
  return initialDemoSchedules.map((s) => ({ ...s }));
}

export function getDemoSnippets(): Snippet[] {
  return initialDemoSnippets.map((s) => ({ ...s }));
}

/** The built-in snippets: the demo workspace's in demo mode, otherwise the neutral defaults. */
export function getBuiltinSnippets(): Snippet[] {
  return isDemoMode() ? getDemoSnippets() : getDefaultSnippets();
}

/** The built-in skills and memories: the demo workspace's in demo mode, otherwise none. */
export function getBuiltinSkillsAndMemories(): MemoryEntry[] {
  if (!isDemoMode()) return getDefaultSkillsAndMemories();
  return demoMemoriesStore
    .filter((m) => m.kind === "skill" || m.id.startsWith("builtin-"))
    .map((m) => ({ ...m }));
}

export function updateDemoServer(input: {
  profileId: string;
  cluster?: string;
  nodeRole?: string;
  description?: string;
  role?: string;
  tags?: string[];
}): boolean {
  const existing = demoServersStore.get(input.profileId);
  if (!existing) return false;
  demoServersStore.set(input.profileId, {
    ...existing,
    cluster:
      input.cluster !== undefined
        ? input.cluster.trim() || undefined
        : existing.cluster,
    nodeRole:
      input.nodeRole !== undefined
        ? input.nodeRole.trim() || undefined
        : existing.nodeRole,
    // Only what was sent changes.
    description: input.description !== undefined ? input.description.trim() || undefined : existing.description,
    role: input.role !== undefined ? input.role.trim() || undefined : existing.role,
    tags: input.tags !== undefined ? (input.tags.length ? input.tags : undefined) : existing.tags,
    updatedAt: new Date().toISOString(),
    updatedBy: "jacob (demo)",
  });
  return true;
}

export function upsertDemoServer(input: {
  id: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  authType?: WorkspaceServerSummary["authType"];
  privateKeyPath?: string;
  pkcs11LibPath?: string;
  fido2Resident?: boolean;
  proxyJump?: string;
  proxyJumpProfileId?: string;
  forwardAgent?: boolean;
  x11Forwarding?: boolean;
  x11Display?: string;
  compression?: boolean;
  serverAliveInterval?: number;
  initialPath?: string;
  poolId?: string;
  dotfilesSyncPolicy?: "ask" | "always";
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;
  extraOptions?: Record<string, string>;
  tunnels?: WorkspaceServerSummary["tunnels"];
  folder?: string;
  cluster?: string;
  nodeRole?: string;
  role?: string;
  description?: string;
  tags?: string[];
  shared?: boolean;
}): WorkspaceServerSummary {
  const existing = demoServersStore.get(input.id);
  const next: WorkspaceServerSummary = {
    ...existing,
    id: input.id,
    name: input.name.trim(),
    host: input.host.trim(),
    port: input.port || 22,
    username: input.username.trim() || "root",
    authType: input.authType ?? existing?.authType,
    privateKeyPath: input.privateKeyPath ?? existing?.privateKeyPath,
    pkcs11LibPath: input.pkcs11LibPath ?? existing?.pkcs11LibPath,
    fido2Resident: input.fido2Resident ?? existing?.fido2Resident,
    proxyJump: input.proxyJump ?? existing?.proxyJump,
    proxyJumpProfileId: input.proxyJumpProfileId ?? existing?.proxyJumpProfileId,
    forwardAgent: input.forwardAgent ?? existing?.forwardAgent,
    x11Forwarding: input.x11Forwarding ?? existing?.x11Forwarding,
    x11Display: input.x11Display ?? existing?.x11Display,
    compression: input.compression ?? existing?.compression,
    serverAliveInterval: input.serverAliveInterval ?? existing?.serverAliveInterval,
    initialPath: input.initialPath ?? existing?.initialPath,
    poolId: input.poolId ?? existing?.poolId,
    dotfilesSyncPolicy: input.dotfilesSyncPolicy ?? existing?.dotfilesSyncPolicy,
    autoReconnect: input.autoReconnect ?? existing?.autoReconnect,
    maxReconnectAttempts: input.maxReconnectAttempts ?? existing?.maxReconnectAttempts,
    reconnectDelayMs: input.reconnectDelayMs ?? existing?.reconnectDelayMs,
    extraOptions: input.extraOptions ?? existing?.extraOptions,
    tunnels: input.tunnels ?? existing?.tunnels,
    folder: input.folder?.trim() || input.cluster?.trim() || existing?.folder,
    group: input.folder?.trim() || input.cluster?.trim() || existing?.group,
    cluster: input.cluster?.trim() || undefined,
    nodeRole: input.nodeRole?.trim() || undefined,
    role: input.role?.trim() || undefined,
    description: input.description?.trim() || undefined,
    tags: input.tags?.length ? input.tags : undefined,
    shared: input.shared ?? true,
    updatedAt: new Date().toISOString(),
    updatedBy: "jacob",
  };
  demoServersStore.set(next.id, next);
  return next;
}

export function deleteDemoServer(id: string): void {
  demoServersStore.delete(id);
}

export function getDemoActivityLog(): WorkspaceActivityEvent[] {
  return [...demoActivityStore];
}

export function appendDemoActivity(event: WorkspaceActivityEvent): void {
  const idx = demoActivityStore.findIndex((e) => e.id === event.id);
  if (idx >= 0) demoActivityStore[idx] = event;
  else demoActivityStore.unshift(event);
}

export function getDemoMemories(): MemoryEntry[] {
  return [...demoMemoriesStore];
}

export function saveDemoMemory(entry: MemoryEntry): void {
  const idx = demoMemoriesStore.findIndex((m) => m.id === entry.id);
  if (idx >= 0) demoMemoriesStore[idx] = entry;
  else demoMemoriesStore.unshift(entry);
}

export function deleteDemoMemory(id: string): void {
  const idx = demoMemoriesStore.findIndex((m) => m.id === id);
  if (idx >= 0) demoMemoriesStore.splice(idx, 1);
}

const initialDemoAgents: MissionAgent[] = [
  {
    id: "demo-agent-ontap-architect",
    name: "NetApp ONTAP Storage Architect",
    role: "ONTAP 9.15 All-Flash SAN/NAS, QoS & SnapMirror Specialist",
    // The file cabinet emoji as an escape: its UTF-8 bytes match a byte-wise search for Swedish letters.
    icon: "\u{1F5C4}\uFE0F",
    mission:
      "Monitor and tune the NetApp AFF A800 and FAS9000: analyze WAFL/NVRAM latency, manage FlexVol/FlexGroup volumes, set QoS limits against noisy neighbors, and verify SnapMirror XDP and SnapLock replication.",
    systemPrompt: [
      "You are a senior NetApp ONTAP 9.15 storage architect for the cluster NetApp-ONTAP-Prod-SE.",
      "- Start with non-destructive ONTAP CLI commands (`qos statistics volume latency show`, `storage aggregate show`, `volume show`, `snapmirror show`).",
      "- When latency on `aggr2_nvme_db` is above 1.5 ms, find the noisy neighbors and propose `volume modify -qos-policy-group pg-batch-ceiling`.",
      "- Read the knowledge base document 'NetApp ONTAP QoS, 9.15 CLI & FabricPool Reference' before you propose changes to a production SVM.",
    ].join("\n"),
    targetCluster: "NetApp-ONTAP-Prod-SE",
    defaultMode: "assisted",
    allowedTools: ["all"],
    kbDocIds: ["demo-kb-ontap-cli-qos"],
    mcpServerIds: ["demo-mcp-netapp-harvest"],
    updatedAt: now - 12 * min,
    author: "erik@acme.se",
  },
  {
    id: "demo-agent-storagegrid-ilm",
    name: "StorageGRID & S3 ILM Specialist",
    role: "NetApp StorageGRID 11.8, FabricPool & MinIO AIStor Engineer",
    icon: "🪣",
    mission:
      "Keep S3 available, keep the erasure coding 6+3 ILM policy and S3 Object Lock (WORM) compliant, and keep FabricPool tiering between ONTAP and StorageGRID healthy.",
    systemPrompt: [
      "You are responsible for NetApp StorageGRID 11.8 (`NetApp-StorageGRID-S3`) and the MinIO AIStor NVMe cache.",
      "- Check the S3 endpoints, multipart uploads, the ILM queues and the availability of the FabricPool object store.",
      "- Use `sshs3_storage_ops` to inspect buckets and to compare configuration between nodes.",
    ].join("\n"),
    targetCluster: "NetApp-StorageGRID-S3",
    defaultMode: "assisted",
    allowedTools: ["all"],
    kbDocIds: ["demo-kb-storagegrid-ilm"],
    mcpServerIds: ["demo-mcp-s3-inspector"],
    updatedAt: now - 25 * min,
    author: "sara@acme.se",
  },
  {
    id: "demo-agent-ceph-zfs-sre",
    name: "Ceph & ZFS Reliability SRE",
    role: "Ceph Reef BlueStore NVMe & TrueNAS OpenZFS Engineer",
    icon: "⚡",
    mission:
      "Keep the Ceph NVMe pool (`rbd-nvme-prod`) at HEALTH_OK, analyze slow ops and PG scrubbing, and verify the immutable ZFS snapshots on TrueNAS.",
    systemPrompt: [
      "You are a specialist in Ceph Reef (18.2) BlueStore NVMe and OpenZFS 2.2 on TrueNAS Enterprise.",
      "- Always check `ceph status`, `ceph health detail`, `ceph osd df tree` and `zpool status`.",
      "- During office hours (07:00–19:00), keep `osd_max_backfills` <= 2 to protect KVM/OpenStack latency.",
    ].join("\n"),
    targetCluster: "Ceph-NVMe-Block-Pool",
    defaultMode: "assisted",
    allowedTools: ["all"],
    kbDocIds: ["demo-kb-ceph-reef-ops"],
    mcpServerIds: [],
    updatedAt: now - 40 * min,
    author: "linnea@acme.se",
  },
  {
    id: "demo-agent-k8s-trident-csi",
    name: "Kubernetes Astra Trident CSI Debugger",
    role: "K8s PVC, NFSv4.1 nconnect & DM-Multipath iSCSI/NVMe-oF Specialist",
    icon: "☸️",
    mission:
      "Troubleshoot and fix PVCs stuck in Pending, VolumeAttachment errors, iSCSI multipath/ALUA and NFSv4.1 export policies between Kubernetes and NetApp ONTAP.",
    systemPrompt: [
      "You troubleshoot Kubernetes storage with NetApp Astra Trident CSI 24.06 in the cluster `K8s-Trident-CSI-Prod`.",
      "- Always check the Kubernetes side (`kubectl describe pvc`, `tridentctl logs`) against the ONTAP side (`vserver export-policy`, `lun mapping show`, `igroup show`).",
    ].join("\n"),
    targetCluster: "K8s-Trident-CSI-Prod",
    defaultMode: "assisted",
    allowedTools: ["all"],
    kbDocIds: ["demo-kb-trident-csi"],
    mcpServerIds: ["demo-mcp-netapp-harvest"],
    updatedAt: now - 18 * min,
    author: "jacob",
  },
  {
    id: "builtin-agent-linux-sre",
    name: "Linux & Systemd SRE Architect",
    role: "Linux Kernel, Systemd, Performance (USE Method) & Container SRE",
    icon: "🐧",
    mission:
      "Troubleshoot high CPU or load, OOM kills, disk I/O bottlenecks, crashing systemd services, Docker/containerd and network latency on any Linux server.",
    systemPrompt: [
      "You are a senior Linux and infrastructure SRE.",
      "- Always apply Brendan Gregg's USE method (Utilization, Saturation, Errors), starting with non-destructive commands (`uptime`, `vmstat`, `iostat -xz`, `systemctl --failed`, `journalctl -p err`).",
      "- Always back up a configuration file before you edit it, and check its syntax before you restart a service.",
    ].join("\n"),
    defaultMode: "assisted",
    allowedTools: ["all"],
    kbDocIds: ["builtin-kb-linux-use-sre", "builtin-kb-postgres-container"],
    mcpServerIds: [],
    updatedAt: now - 10 * min,
    author: "sshs3-stdlib",
  },
  {
    id: "builtin-agent-ssh-security",
    name: "SSH, Bastion & Security Auditor",
    role: "OpenSSH Hardening, ProxyJump, Port-Forwarding & YubiKey/FIDO2 Specialist",
    icon: "🔐",
    mission:
      "Review and harden `sshd_config`, set up secure ProxyJump bastions, and troubleshoot SSH tunnels (`-L`/`-R`/`-D`), firewall rules (`nftables`/`ufw`) and FIDO2/PIV keys.",
    systemPrompt: [
      "You are a security and OpenSSH specialist for bastion hops, encrypted tunnels and Linux hardening.",
      "- Always run `sudo sshd -t` before you reload `sshd`, so that you never lock the administrator out.",
      "- Recommend Ed25519-SK (FIDO2/YubiKey) or certificate-based authentication, `PermitRootLogin prohibit-password` and strict `AllowUsers`/`Match` blocks.",
    ].join("\n"),
    defaultMode: "assisted",
    allowedTools: ["all"],
    kbDocIds: ["builtin-kb-openssh-fido2"],
    mcpServerIds: [],
    updatedAt: now - 15 * min,
    author: "sshs3-stdlib",
  },
];

const initialDemoMcpServers: McpServerConfig[] = [
  {
    id: "demo-mcp-netapp-harvest",
    name: "NetApp Harvest & ActiveIQ MCP",
    transport: "http",
    url: "http://10.30.10.25:8890/mcp",
    enabled: true,
    status: "connected",
    lastTestedAt: now - 15 * min,
    discoveredTools: [
      {
        name: "ontap_get_volume_metrics",
        description:
          "Fetch real-time IOPS, throughput, and WAFL/QoS latency breakdown from NetApp Harvest / ActiveIQ.",
      },
      {
        name: "ontap_list_snapmirror_lags",
        description:
          "List all SnapMirror XDP relationships across Stockholm DC1 and Uppsala DC2 with lag-time and SnapLock status.",
      },
      {
        name: "trident_inspect_pvc_mapping",
        description:
          "Map a Kubernetes PVC name to its underlying NetApp ONTAP SVM, FlexVol/FlexGroup, LUN, or qtree.",
      },
    ],
  },
  {
    id: "demo-mcp-s3-inspector",
    name: "StorageGRID & S3 Compliance MCP",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@acme-storage/mcp-storagegrid-inspector", "--endpoint", "https://s3-dc1.storage.acme.se:10443"],
    enabled: true,
    status: "connected",
    lastTestedAt: now - 30 * min,
    discoveredTools: [
      {
        name: "storagegrid_ilm_queue_status",
        description:
          "Check NetApp StorageGRID ILM evaluation rate, queued objects, and Erasure Coding 6+3 repair progress.",
      },
      {
        name: "s3_verify_object_lock",
        description:
          "Verify WORM Object Lock retention mode and compliance settings on S3 buckets.",
      },
    ],
  },
];

const initialDemoKbDocuments: KbDocument[] = [
  {
    id: "demo-kb-ontap-cli-qos",
    title: "NetApp ONTAP QoS, 9.15 CLI & FabricPool Reference",
    sourceType: "upload",
    sourceRef: "ontap-9.15-operations-handbook.md",
    cluster: "NetApp-ONTAP-Prod-SE",
    tags: ["netapp", "ontap", "qos", "fabricpool", "snapmirror"],
    content: [
      "# NetApp ONTAP 9.15 Operations Handbook (Stockholm DC1 & Uppsala DC2)",
      "",
      "## 1. Latency Diagnosis & Adaptive QoS",
      "Use `qos statistics volume latency show -iterations 5 -rows 15` to inspect latency by cluster center (Network, Cluster, Data, Disk, QoS-Max, WAFL).",
      "- Standard production policy: `pg-prod-db-extreme` (min 10,000 IOPS, max 120,000 IOPS, expected latency < 0.5ms).",
      "- Batch / scratch throttling policy: `pg-batch-ceiling` (max 15,000 IOPS, max 600 MB/s).",
      "Command to apply QoS ceiling:",
      "`volume modify -vserver <svm> -volume <vol> -qos-policy-group pg-batch-ceiling`",
      "",
      "## 2. FabricPool S3 Tiering to StorageGRID",
      "Aggregates `aggr1_nvme_prod` and `aggr2_nvme_db` attach to `sg-fabricpool-dc1` (`ontap-fabricpool-tier`).",
      "- Recommended tiering policy for Kubernetes PVCs: `auto` with `tiering-minimum-cooling-days 14`.",
      "- Recommended tiering policy for transactional DB volumes: `snapshot-only`.",
      "- Check tiering health: `storage aggregate object-store show -instance`.",
    ].join("\n"),
    chunks: [
      {
        id: "demo-kb-ontap-cli-qos#0",
        heading: "1. Latency Diagnosis & Adaptive QoS",
        text: "Use `qos statistics volume latency show -iterations 5 -rows 15` to inspect latency by cluster center (Network, Cluster, Data, Disk, QoS-Max, WAFL). Standard production policy: `pg-prod-db-extreme`. Batch throttling policy: `pg-batch-ceiling` (max 15,000 IOPS, max 600 MB/s). Command: `volume modify -vserver <svm> -volume <vol> -qos-policy-group pg-batch-ceiling`.",
      },
      {
        id: "demo-kb-ontap-cli-qos#1",
        heading: "2. FabricPool S3 Tiering to StorageGRID",
        text: "Aggregates `aggr1_nvme_prod` and `aggr2_nvme_db` attach to `sg-fabricpool-dc1` (`ontap-fabricpool-tier`). Recommended tiering policy for Kubernetes PVCs: `auto` with `tiering-minimum-cooling-days 14`. Check health: `storage aggregate object-store show -instance`.",
      },
    ],
    updatedAt: now - 20 * min,
    shared: true,
  },
  {
    id: "demo-kb-storagegrid-ilm",
    title: "NetApp StorageGRID 11.8 ILM, Erasure Coding 6+3 & WORM Guide",
    sourceType: "s3",
    sourceRef: "s3://ontap-fabricpool-tier/runbooks/storagegrid-ilm-guide.md",
    cluster: "NetApp-StorageGRID-S3",
    tags: ["storagegrid", "s3", "ilm", "erasure-coding", "worm"],
    content: [
      "# NetApp StorageGRID 11.8 Architecture & ILM Guide",
      "",
      "## Active ILM Policy: ILM-Prod-FabricPool-EC63",
      "- Rule 1 (`FabricPool-Cold-Blocks`): Objects > 64 KB in bucket `ontap-fabricpool-tier` use 6+3 Erasure Coding across `sg-sn-nvme-01`, `sg-sn-nvme-02` and Uppsala DC2 storage nodes.",
      "- Rule 2 (`AI-Checkpoints-Hot`): Replicated 2-copies on All-NVMe storage nodes for 30 days, then EC 6+3.",
      "",
      "## Troubleshooting High S3 Latency or 503 SlowDown",
      "1. Check Load Balancer service on `sg-admin-primary-01`: `storagegrid-status`.",
      "2. Inspect Cassandra/RangedDB disk latency on `sg-sn-nvme-01` and `sg-sn-nvme-02`: `iostat -xz 1 5`.",
      "3. Verify S3 certificate and HA VIP on port `10443`.",
    ].join("\n"),
    chunks: [
      {
        id: "demo-kb-storagegrid-ilm#0",
        heading: "Active ILM Policy: ILM-Prod-FabricPool-EC63",
        text: "Rule 1 (`FabricPool-Cold-Blocks`): Objects > 64 KB in bucket `ontap-fabricpool-tier` use 6+3 Erasure Coding across `sg-sn-nvme-01`, `sg-sn-nvme-02` and Uppsala DC2. Rule 2 (`AI-Checkpoints-Hot`): Replicated 2-copies on All-NVMe nodes for 30 days.",
      },
      {
        id: "demo-kb-storagegrid-ilm#1",
        heading: "Troubleshooting High S3 Latency or 503 SlowDown",
        text: "Check Load Balancer service on `sg-admin-primary-01`: `storagegrid-status`. Inspect RangedDB disk latency on `sg-sn-nvme-01` and `sg-sn-nvme-02`: `iostat -xz 1 5`.",
      },
    ],
    updatedAt: now - 35 * min,
    shared: true,
  },
  {
    id: "demo-kb-ceph-reef-ops",
    title: "Ceph Reef 18.2 NVMe BlueStore & TrueNAS ZFS Operations",
    sourceType: "folder",
    sourceRef: "/etc/ceph/docs/ceph-reef-nvme-runbook.md",
    cluster: "Ceph-NVMe-Block-Pool",
    tags: ["ceph", "bluestore", "nvme", "truenas", "zfs"],
    content: [
      "# Ceph Reef NVMe & TrueNAS ZFS Operations",
      "",
      "## Ceph Pool Layout",
      "- `rbd-nvme-prod`: size=3, min_size=2, pg_num=512, crush_rule=`nvme_rack_isolated`.",
      "- Network: Dual 100GbE RoCEv2 (`10.30.40.0/24` public, `10.30.140.0/24` cluster).",
      "",
      "## Handling OSD Nearfull or Slow Ops",
      "- Check OSD tree utilization: `ceph osd df tree`.",
      "- Enable upmap balancer: `ceph balancer on && ceph balancer mode upmap`.",
      "- Inspect slow ops: `ceph daemon osd.0 dump_historic_slow_ops`.",
    ].join("\n"),
    chunks: [
      {
        id: "demo-kb-ceph-reef-ops#0",
        heading: "Ceph Pool Layout & Handling Slow Ops",
        text: "`rbd-nvme-prod`: size=3, min_size=2, pg_num=512, crush_rule=`nvme_rack_isolated`. Check OSD utilization: `ceph osd df tree`. Enable upmap balancer: `ceph balancer on`. Inspect slow ops: `ceph daemon osd.0 dump_historic_slow_ops`.",
      },
    ],
    updatedAt: now - 50 * min,
    shared: true,
  },
  {
    id: "demo-kb-trident-csi",
    title: "Astra Trident 24.06 CSI & Linux Multipath Configuration Standard",
    sourceType: "upload",
    sourceRef: "trident-csi-multipath-standard.md",
    cluster: "K8s-Trident-CSI-Prod",
    tags: ["kubernetes", "trident", "multipath", "nfsv4.1", "iscsi"],
    content: [
      "# Astra Trident 24.06 CSI & Linux DM-Multipath Standard",
      "",
      "## Required `/etc/multipath.conf` for NetApp ONTAP LUNs",
      "All Kubernetes worker nodes (`k8s-gpu-io-worker-01`) must use ALUA `group_by_prio`, `path_checker tur`, `features \"2 pg_init_retries 50\"`, and `no_path_retry queue`.",
      "",
      "## NFSv4.1 Mount Options for AI/GPU Workloads",
      "StorageClass `ontap-flexgroup-ai` requires `nfsvers=4.1,nconnect=8,rsize=262144,wsize=262144,noatime,hard`.",
    ].join("\n"),
    chunks: [
      {
        id: "demo-kb-trident-csi#0",
        heading: "Required /etc/multipath.conf & NFSv4.1 Mount Options",
        text: "All Kubernetes worker nodes (`k8s-gpu-io-worker-01`) must use ALUA `group_by_prio`, `path_checker tur`, `no_path_retry queue`. StorageClass `ontap-flexgroup-ai` requires `nfsvers=4.1,nconnect=8,rsize=262144,wsize=262144,noatime,hard`.",
      },
    ],
    updatedAt: now - 28 * min,
    shared: true,
  },
  {
    id: "builtin-kb-snapmirror-ransomware",
    title: "NetApp SnapMirror XDP, SnapLock WORM & Ransomware Recovery SOP",
    sourceType: "manual",
    sourceRef: "stdlib://netapp-snapmirror-ransomware-sop.md",
    cluster: "NetApp-ONTAP-Prod-SE",
    tags: ["netapp", "snapmirror", "snaplock", "ransomware", "dr"],
    content: [
      "# NetApp SnapMirror XDP & Autonomous Ransomware Protection (ARP) SOP",
      "",
      "## 1. Diagnosing SnapMirror Lag or Broken-Off State",
      "- List unhealthy relationships: `snapmirror show -healthy false -fields source-path,destination-path,state,status,lag-time,last-transfer-error`.",
      "- Verify Intercluster LIF reachability & MTU 9000: `cluster peer ping -aca true`.",
      "- Resync broken relationship: `snapmirror resync -destination-path <svm>:<vol>`.",
      "",
      "## 2. Ransomware Recovery via Tamperproof SnapLock Snapshots",
      "- Inspect immutable snapshots: `volume snapshot show -vserver <svm> -volume <vol> -fields snaplock-expiry-time`.",
      "- Restore volume instantaneously (< 10 seconds) using SnapRestore: `volume snapshot restore -vserver <svm> -volume <vol> -snapshot <clean_snap>`.",
    ].join("\n"),
    chunks: [
      {
        id: "builtin-kb-snapmirror-ransomware#0",
        heading: "1. Diagnosing SnapMirror Lag or Broken-Off State",
        text: "List unhealthy relationships: `snapmirror show -healthy false`. Verify Intercluster LIF reachability & MTU 9000: `cluster peer ping -aca true`. Resync broken relationship: `snapmirror resync -destination-path <svm>:<vol>`.",
      },
      {
        id: "builtin-kb-snapmirror-ransomware#1",
        heading: "2. Ransomware Recovery via Tamperproof SnapLock Snapshots",
        text: "Inspect immutable snapshots: `volume snapshot show -fields snaplock-expiry-time`. Restore volume instantaneously using SnapRestore: `volume snapshot restore -vserver <svm> -volume <vol> -snapshot <clean_snap>`.",
      },
    ],
    updatedAt: now - 32 * min,
    shared: true,
  },
  {
    id: "builtin-kb-linux-use-sre",
    title: "Linux SRE Incident & Performance Triage (USE Method & Systemd)",
    sourceType: "manual",
    sourceRef: "stdlib://linux-sre-use-method-runbook.md",
    tags: ["linux", "sre", "systemd", "performance", "iostat", "oom"],
    content: [
      "# Linux SRE 60-Second Performance & Incident Triage (USE Method)",
      "",
      "## 1. CPU, Memory, I/O & Kernel Triage",
      "1. `uptime` — check load averages vs CPU core count (`nproc`).",
      "2. `dmesg -T | tail -n 25` — check for OOM-killer (`Out of memory: Killed process`), I/O timeouts, or XFS/ext4 errors.",
      "3. `vmstat 1 5` — inspect runnable queue (`r`), swap in/out (`si`/`so`), and CPU `wa` (I/O wait).",
      "4. `iostat -xz 1 3` — inspect `%util`, `r_await`, `w_await`, and `aqu-sz` per NVMe/block device.",
      "",
      "## 2. Systemd Service & Journal Recovery",
      "- Check failed units: `systemctl --failed`.",
      "- Inspect service crash logs: `journalctl -u <service> -n 100 --no-pager`.",
      "- Verify config before restart: `nginx -t`, `sshd -t`, `haproxy -c -f /etc/haproxy/haproxy.cfg`.",
    ].join("\n"),
    chunks: [
      {
        id: "builtin-kb-linux-use-sre#0",
        heading: "1. CPU, Memory, I/O & Kernel Triage",
        text: "Run `uptime`, `dmesg -T | tail -n 25` (check for OOM-killer or I/O timeouts), `vmstat 1 5`, and `iostat -xz 1 3` (`%util`, `r_await`, `w_await`, `aqu-sz`).",
      },
      {
        id: "builtin-kb-linux-use-sre#1",
        heading: "2. Systemd Service & Journal Recovery",
        text: "Check failed units: `systemctl --failed`. Inspect crash logs: `journalctl -u <service> -n 100 --no-pager`. Verify syntax (`nginx -t`, `sshd -t`) before restart.",
      },
    ],
    updatedAt: now - 40 * min,
    shared: true,
  },
  {
    id: "builtin-kb-openssh-fido2",
    title: "OpenSSH Hardening, ProxyJump Bastions, Tunnels & YubiKey/FIDO2 Guide",
    sourceType: "manual",
    sourceRef: "stdlib://openssh-bastion-fido2-guide.md",
    tags: ["ssh", "security", "bastion", "fido2", "yubikey", "tunnel"],
    content: [
      "# OpenSSH Hardening, Bastion Jump-Hosts & Hardware Key Guide",
      "",
      "## 1. Recommended `/etc/ssh/sshd_config` Production Baseline",
      "- `PermitRootLogin prohibit-password` (or `no` with sudo admin accounts).",
      "- `PasswordAuthentication no` and `KbdInteractiveAuthentication no`.",
      "- `PubkeyAuthentication yes` with `ed25519-sk` (FIDO2/YubiKey) and `ssh-ed25519`.",
      "- Always validate changes with `sudo sshd -t` before `sudo systemctl reload sshd`.",
      "",
      "## 2. SSH Port-Forwarding & ProxyJump Patterns",
      "- Local forward (`-L`): expose internal Grafana/Prometheus/Postgres (`127.0.0.1:5432`) locally through bastion.",
      "- Dynamic SOCKS5 (`-D 1080`): route browser or MCP inspector traffic through jump host.",
    ].join("\n"),
    chunks: [
      {
        id: "builtin-kb-openssh-fido2#0",
        heading: "1. Recommended /etc/ssh/sshd_config Production Baseline",
        text: "Set `PermitRootLogin prohibit-password`, `PasswordAuthentication no`, `PubkeyAuthentication yes` with `ed25519-sk` (FIDO2/YubiKey). Always validate with `sudo sshd -t` before `sudo systemctl reload sshd`.",
      },
      {
        id: "builtin-kb-openssh-fido2#1",
        heading: "2. SSH Port-Forwarding & ProxyJump Patterns",
        text: "Local forward (`-L`) exposes internal Grafana/Prometheus/Postgres locally through bastion. Dynamic SOCKS5 (`-D 1080`) routes traffic through jump host.",
      },
    ],
    updatedAt: now - 45 * min,
    shared: true,
  },
  {
    id: "builtin-kb-postgres-container",
    title: "PostgreSQL, Redis & Docker/Containerd Production Recovery Runbook",
    sourceType: "manual",
    sourceRef: "stdlib://postgres-redis-container-runbook.md",
    tags: ["postgres", "database", "redis", "docker", "containerd", "sre"],
    content: [
      "# PostgreSQL, Redis & Container Runtime Production Runbook",
      "",
      "## 1. PostgreSQL Lock, Connection & Latency Triage",
      "- Active slow queries (> 5s): `SELECT pid, now() - query_start AS duration, wait_event_type, state, query FROM pg_stat_activity WHERE state != 'idle' ORDER BY duration DESC LIMIT 15;`",
      "- Check blocking locks: `SELECT pg_blocking_pids(pid), pid, query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;`",
      "- Check replication lag: `SELECT client_addr, state, sync_state, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS byte_lag FROM pg_stat_replication;`",
      "",
      "## 2. Docker & Containerd Health Triage",
      "- Inspect restarting containers: `docker ps -a --filter 'status=restarting' --filter 'status=exited'`.",
      "- Inspect OOMKilled state: `docker inspect <container> --format '{{json .State}}'`.",
    ].join("\n"),
    chunks: [
      {
        id: "builtin-kb-postgres-container#0",
        heading: "1. PostgreSQL Lock, Connection & Latency Triage",
        text: "Check active slow queries via `pg_stat_activity`, blocking locks via `pg_blocking_pids(pid)`, and WAL replication lag via `pg_stat_replication`.",
      },
      {
        id: "builtin-kb-postgres-container#1",
        heading: "2. Docker & Containerd Health Triage",
        text: "Inspect restarting containers (`docker ps -a`) and check OOMKilled state (`docker inspect <container> --format '{{json .State}}'`).",
      },
    ],
    updatedAt: now - 48 * min,
    shared: true,
  },
];

const demoAgentsStore: MissionAgent[] = [...initialDemoAgents];
const demoMcpStore: McpServerConfig[] = [...initialDemoMcpServers];
const demoKbStore: KbDocument[] = [...initialDemoKbDocuments];

export function getDemoAgents(): MissionAgent[] {
  return [...demoAgentsStore];
}

/**
 * The built-in agents: in demo mode the demo workspace's (as saved and deleted in this process),
 * otherwise the neutral defaults.
 */
export function getBuiltinAgents(): MissionAgent[] {
  return isDemoMode() ? getDemoAgents() : getDefaultAgents();
}

export function saveDemoAgent(agent: MissionAgent): void {
  const idx = demoAgentsStore.findIndex((a) => a.id === agent.id);
  if (idx >= 0) demoAgentsStore[idx] = agent;
  else demoAgentsStore.unshift(agent);
}

export function deleteDemoAgent(id: string): void {
  const idx = demoAgentsStore.findIndex((a) => a.id === id);
  if (idx >= 0) demoAgentsStore.splice(idx, 1);
}

export function getDemoMcpServers(): McpServerConfig[] {
  return [...demoMcpStore];
}

export function saveDemoMcpServer(server: McpServerConfig): void {
  const idx = demoMcpStore.findIndex((s) => s.id === server.id);
  if (idx >= 0) demoMcpStore[idx] = server;
  else demoMcpStore.unshift(server);
}

export function deleteDemoMcpServer(id: string): void {
  const idx = demoMcpStore.findIndex((s) => s.id === id);
  if (idx >= 0) demoMcpStore.splice(idx, 1);
}

export function getDemoKbDocuments(): KbDocument[] {
  return [...demoKbStore];
}

/**
 * The built-in knowledge-base documents: in demo mode the demo workspace's (as saved and deleted in this
 * process), otherwise none.
 */
export function getBuiltinKbDocuments(): KbDocument[] {
  return isDemoMode() ? getDemoKbDocuments() : getDefaultKbDocuments();
}

export function saveDemoKbDocument(doc: KbDocument): void {
  const idx = demoKbStore.findIndex((d) => d.id === doc.id);
  if (idx >= 0) demoKbStore[idx] = doc;
  else demoKbStore.unshift(doc);
}

export function deleteDemoKbDocument(id: string): void {
  const idx = demoKbStore.findIndex((d) => d.id === id);
  if (idx >= 0) demoKbStore.splice(idx, 1);
}

/**
 * Starting points offered outside the demo lab. Only packages that exist on
 * npm under a known publisher belong here: "Install" runs the command, so a
 * name nobody has registered would be an open door. Nothing is claimed about
 * a server's tools until it has been started and asked.
 */
export const MCP_PRESETS: McpCatalogPreset[] = [
  {
    id: "preset-mcp-kubernetes",
    name: "Kubernetes",
    category: "kubernetes",
    icon: "",
    description:
      "Pods, deployments, events, logs and Helm releases through kubectl on this computer.",
    needs: "kubectl and a kubeconfig for the cluster on this computer.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-server-kubernetes"],
    defaultTools: [],
  },
  {
    id: "preset-mcp-filesystem",
    name: "Local files",
    category: "storage",
    icon: "",
    description:
      "Read and search a folder on this computer, for example a checkout of your runbooks or infrastructure code.",
    needs: "Replace the last argument with the folder to share before testing.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
    defaultTools: [],
  },
];

/** The catalog shown: invented servers in the demo lab, real ones otherwise. */
export function mcpCatalog(): McpCatalogPreset[] {
  return isDemoMode() ? MCP_MARKETPLACE_CATALOG : MCP_PRESETS;
}

/** Demo lab only: none of these servers exist. */
export const MCP_MARKETPLACE_CATALOG: McpCatalogPreset[] = [
  {
    id: "preset-mcp-prometheus",
    name: "Prometheus & Alertmanager MCP",
    category: "observability",
    icon: "📊",
    description:
      "Run PromQL queries, inspect firing alerts in Alertmanager and correlate node_exporter telemetry from the AI chat.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-prometheus", "--url", "http://10.30.10.25:9090"],
    defaultTools: [
      {
        name: "prometheus_query_range",
        description: "Execute instant or range PromQL queries against Prometheus.",
      },
      {
        name: "alertmanager_list_firing_alerts",
        description: "List all active firing or silenced alerts in Alertmanager.",
      },
    ],
  },
  {
    id: "preset-mcp-grafana-loki",
    name: "Grafana Dashboards & Loki Logs MCP",
    category: "observability",
    icon: "📈",
    description:
      "Fetch panel data from Grafana, search Loki log streams (LogQL) and create incident annotations.",
    transport: "http",
    url: "http://10.30.10.25:3000/api/mcp",
    defaultTools: [
      {
        name: "grafana_get_dashboard_summary",
        description: "Retrieve panel metrics and thresholds from a Grafana dashboard.",
      },
      {
        name: "loki_query_logs",
        description: "Run LogQL queries across cluster syslog and container log streams.",
      },
    ],
  },
  {
    id: "preset-mcp-kubernetes-helm",
    name: "Kubernetes & Helm Official MCP",
    category: "kubernetes",
    icon: "☸️",
    description:
      "Inspect Kubernetes pods, PVCs, CSI events, StatefulSets and Helm releases without leaving the chat.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-server-kubernetes"],
    defaultTools: [
      {
        name: "k8s_list_pods_and_events",
        description: "List Kubernetes pods, node conditions, and warning events.",
      },
      {
        name: "helm_list_releases",
        description: "Inspect deployed Helm charts and revision history.",
      },
    ],
  },
  {
    id: "preset-mcp-postgres-tunnel",
    name: "PostgreSQL & Redis SSH-Tunnel Inspector MCP",
    category: "database",
    icon: "🐘",
    description:
      "Analyze pg_stat_activity, slow SQL queries, table sizes and locks through sshS3's local port-forwarding tunnels.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost:5432/prod"],
    defaultTools: [
      {
        name: "pg_stat_slow_queries",
        description: "Inspect active connections, locks, and top slow queries via pg_stat_statements.",
      },
      {
        name: "pg_describe_schema",
        description: "Read table schemas, indexes, and bloat metrics safely (read-only).",
      },
    ],
  },
  {
    id: "preset-mcp-terraform-ansible",
    name: "Terraform & Ansible IaC Drift MCP",
    category: "gitops",
    icon: "🏗️",
    description:
      "Detect configuration drift between live servers and Terraform state or Ansible playbooks.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@hashicorp/terraform-mcp-server"],
    defaultTools: [
      {
        name: "terraform_detect_drift",
        description: "Compare live infrastructure attributes against Terraform state.",
      },
      {
        name: "ansible_generate_remediation_role",
        description: "Generate an idempotent Ansible task from verified terminal changes.",
      },
    ],
  },
  {
    id: "preset-mcp-github-gitops",
    name: "GitHub / GitLab Infra PR & Runbook MCP",
    category: "gitops",
    icon: "🐙",
    description:
      "Search infrastructure commits, read post-mortems and open a pull request with configuration fixes.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    defaultTools: [
      {
        name: "github_search_infra_commits",
        description: "Search recent infrastructure repository commits and PRs.",
      },
      {
        name: "github_create_remediation_pr",
        description: "Create a branch and pull request with updated config or runbook.",
      },
    ],
  },
  {
    id: "preset-mcp-trivy-falco",
    name: "Trivy CVE Scanner & Falco Runtime Security MCP",
    category: "security",
    icon: "🛡️",
    description:
      "Scan container images, OS packages and Kubernetes clusters for critical CVEs with Aqua Trivy, and read Falco runtime alerts.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-server-trivy"],
    defaultTools: [
      {
        name: "trivy_scan_filesystem_or_image",
        description: "Run Aqua Trivy vulnerability & misconfiguration scan on host or image.",
      },
      {
        name: "falco_list_runtime_alerts",
        description: "Inspect recent eBPF/Falco kernel & container security events.",
      },
    ],
  },
  {
    id: "preset-mcp-netbox-ipam",
    name: "NetBox CMDB, IPAM & SAN Fabric Topology MCP",
    category: "network",
    icon: "🌐",
    description:
      "Look up VLANs, VRFs, rack positions, LIF subnets and switch ports in NetBox, the source of truth.",
    transport: "http",
    url: "http://10.30.10.30:8000/api/mcp",
    defaultTools: [
      {
        name: "netbox_lookup_prefix_and_vlan",
        description: "Query NetBox IPAM prefixes, VLAN IDs, and assigned server interfaces.",
      },
      {
        name: "netbox_get_device_cables",
        description: "Trace physical and SAN/NIC cable peers for a rack server or storage node.",
      },
    ],
  },
  {
    id: "preset-mcp-opentelemetry-jaeger",
    name: "OpenTelemetry & Jaeger Distributed Tracing MCP",
    category: "observability",
    icon: "🔭",
    description:
      "Follow distributed OpenTelemetry traces across microservices, S3 calls and databases to isolate p99 bottlenecks.",
    transport: "http",
    url: "http://10.30.10.25:16686/api/mcp",
    defaultTools: [
      {
        name: "jaeger_find_slow_traces",
        description: "Search OpenTelemetry traces exceeding latency threshold or with error tags.",
      },
      {
        name: "otel_service_dependency_graph",
        description: "Fetch live service-to-service call latency and error rates.",
      },
    ],
  },
];

const initialDemoInfraEdges: InfraGraphEdge[] = [
  {
    id: "edge-k8s-mounts-ontap",
    from: "k8s-gpu-io-worker-01",
    to: "netapp-aff-a800-01a",
    relation: "mounts_storage",
    label: "NFSv4.1 nconnect=8 & iSCSI Multipath (Astra Trident)",
    updatedAt: now - 15 * min,
  },
  {
    id: "edge-ontap-ha-pair",
    from: "netapp-aff-a800-01a",
    to: "netapp-aff-a800-01b",
    relation: "depends_on",
    label: "NVMe-oF HA Pair & SyncMirror",
    updatedAt: now - 30 * min,
  },
  {
    id: "edge-ontap-snapmirror-dr",
    from: "netapp-aff-a800-01a",
    to: "netapp-fas9000-dr-01",
    relation: "replicates_to",
    label: "SnapMirror XDP -> Uppsala DC2 (RPO 15m)",
    updatedAt: now - 10 * min,
  },
  {
    id: "edge-ontap-fabricpool-s3",
    from: "netapp-aff-a800-01b",
    to: "sg-sn-nvme-01",
    relation: "routes_to",
    label: "FabricPool Cold Block Tiering -> StorageGRID S3 (EC 6+3)",
    updatedAt: now - 25 * min,
  },
  {
    id: "edge-aiq-monitors-ontap",
    from: "ontap-aiq-um-01",
    to: "netapp-aff-a800-01a",
    relation: "monitors",
    label: "ActiveIQ Unified Manager + Harvest MCP Telemetry",
    updatedAt: now - 5 * min,
  },
  {
    id: "edge-ceph-replicates-zfs",
    from: "ceph-osd-nvme-01",
    to: "truenas-zfs-vault-01",
    relation: "replicates_to",
    label: "Nightly RBD Snapshot Export -> Immutable ZFS Pool",
    updatedAt: now - 45 * min,
  },
];

const initialDemoWorkforceRuns: WorkforceRun[] = [
  {
    id: "demo-wf-cross-cluster-audit",
    title: "Cross-cluster storage and K8s latency triage (multi-agent workforce)",
    prompt:
      "Analyze why the AI training jobs in K8s see p99 I/O spikes, and check ONTAP QoS, StorageGRID FabricPool and Ceph NVMe health in parallel.",
    leadAgentName: "Lead SRE Workforce Orchestrator",
    targetCluster: "ALL",
    status: "completed",
    createdAt: now - 14 * min,
    updatedAt: now - 13 * min,
    steps: [
      {
        id: "wf-step-1",
        agentId: "demo-agent-ontap-architect",
        agentName: "NetApp ONTAP Storage Architect",
        agentIcon: "\u{1F5C4}\uFE0F",
        role: "ONTAP 9.15 SAN/NAS & QoS",
        targetCluster: "NetApp-ONTAP-Prod-SE",
        subTask:
          "Check WAFL/QoS latency on aggr2_nvme_db and SnapMirror status to Uppsala DR.",
        status: "completed",
        findings:
          "The scratch volume `vol_ai_scratch_03` had no QoS ceiling and drove up the queue depth on `netapp-aff-a800-01b` (2.45 ms read latency). Recommends `pg-batch-ceiling` (max 15 000 IOPS).",
        recommendedCommands: [
          "qos statistics volume latency show -iterations 1",
          "volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling",
        ],
        durationMs: 1420,
      },
      {
        id: "wf-step-2",
        agentId: "demo-agent-k8s-trident-csi",
        agentName: "Kubernetes Astra Trident CSI Debugger",
        agentIcon: "☸️",
        role: "K8s PVC & Multipath Specialist",
        targetCluster: "K8s-Trident-CSI-Prod",
        subTask:
          "Check the DM-Multipath ALUA policy and NFSv4.1 nconnect on k8s-gpu-io-worker-01.",
        status: "completed",
        findings:
          "On `k8s-gpu-io-worker-01`, `/etc/multipath.conf` used `multibus` instead of `group_by_prio` (ALUA), which sent I/O over non-optimized paths under high load.",
        recommendedCommands: [
          "multipath -ll",
          "kubectl get pvc,volumeattachment -n ai-training -o wide",
        ],
        durationMs: 1180,
      },
      {
        id: "wf-step-3",
        agentId: "demo-agent-storagegrid-ilm",
        agentName: "StorageGRID & S3 ILM Specialist",
        agentIcon: "🪣",
        role: "StorageGRID 11.8 & S3 Tiering",
        targetCluster: "NetApp-StorageGRID-S3",
        subTask:
          "Check S3 PUT/GET latency and the ILM erasure coding 6+3 queues during FabricPool tiering.",
        status: "completed",
        findings:
          "The StorageGRID S3 cluster is healthy (p99 GET 3.4 ms on `sg-sn-nvme-01`, ILM queue under 120 objects, WORM Object Lock verified).",
        recommendedCommands: ["iostat -xz 1 2"],
        durationMs: 950,
      },
    ],
    synthesis: [
      "### Combined workforce diagnosis (3 specialist agents in parallel)",
      "1. **Root cause 1 (NetApp ONTAP)**: the volume `vol_ai_scratch_03` on `netapp-aff-a800-01b` had no QoS ceiling and caused noisy-neighbor latency (`2.45 ms`).",
      "2. **Root cause 2 (Kubernetes multipath)**: `k8s-gpu-io-worker-01` had `path_grouping_policy multibus` instead of ALUA `group_by_prio` in `/etc/multipath.conf`.",
      "3. **S3 and DR status**: StorageGRID S3 (`ILM-Prod-FabricPool-EC63`) is healthy, and Ceph/ZFS is at `HEALTH_OK`.",
    ].join("\n"),
  },
];

const demoInfraEdgesStore: InfraGraphEdge[] = [...initialDemoInfraEdges];
const demoWorkforceRunsStore: WorkforceRun[] = [...initialDemoWorkforceRuns];

export function getDemoInfraEdges(): InfraGraphEdge[] {
  return [...demoInfraEdgesStore];
}

export function saveDemoInfraEdge(edge: InfraGraphEdge): void {
  const idx = demoInfraEdgesStore.findIndex((e) => e.id === edge.id);
  if (idx >= 0) demoInfraEdgesStore[idx] = edge;
  else demoInfraEdgesStore.unshift(edge);
}

export function deleteDemoInfraEdge(id: string): void {
  const idx = demoInfraEdgesStore.findIndex((e) => e.id === id);
  if (idx >= 0) demoInfraEdgesStore.splice(idx, 1);
}

export function getDemoWorkforceRuns(): WorkforceRun[] {
  return [...demoWorkforceRunsStore];
}

export function saveDemoWorkforceRun(run: WorkforceRun): void {
  const idx = demoWorkforceRunsStore.findIndex((r) => r.id === run.id);
  if (idx >= 0) demoWorkforceRunsStore[idx] = run;
  else demoWorkforceRunsStore.unshift(run);
}

const initialDemoTasks: AgentTask[] = [
  {
    id: "demo-task-ontap-latency-triage",
    title: "ONTAP 9.15 noisy-neighbor latency and K8s multipath analysis",
    agentId: "demo-agent-ontap-architect",
    agentName: "NetApp ONTAP Storage Architect",
    mode: "assisted",
    status: "completed",
    verification: "verified",
    maxCommands: 15,
    maxMinutes: 15,
    createdAt: now - 19 * min,
    updatedAt: now - 16 * min,
    sources: [
      {
        id: "src-ontap-kb",
        label: "@kb:netapp-ontap-9-15-cli-qos",
        text: "NetApp ONTAP 9.15 Operations Handbook — Latency Diagnosis & Adaptive QoS",
        observedAt: now - 19 * min,
      },
    ],
    messages: [
      {
        id: "msg-demo-1",
        role: "user",
        text: "We see p99 latency spikes on the PostgreSQL LUNs in `aggr2_nvme_db` on @netapp-aff-a800-01b while the AI training jobs on @k8s-gpu-io-worker-01 run at full load. Can you find the root cause and fix it?",
        at: now - 19 * min,
      },
      {
        id: "msg-demo-2",
        role: "assistant",
        text: [
          "### Root cause: noisy neighbor on `aggr2_nvme_db` and DM-Multipath ALUA",
          "",
          "I ran diagnostics on **`netapp-aff-a800-01b`** and checked the result against **`k8s-gpu-io-worker-01`**:",
          "",
          "| Volume / component | Node / SVM | IOPS | Latency | Observation |",
          "| :--- | :--- | :--- | :--- | :--- |",
          "| `vol_ai_scratch_03` | `svm-prod-nfs` (`aggr2_nvme_db`) | `48 200 IOPS` | `2.45 ms` | **No QoS policy (`none`)**: drives up the WAFL/NVMe queue depth |",
          "| `vol_pg_prod_db01` | `svm-prod-iscsi` (`aggr2_nvme_db`) | `28 400 IOPS` | `1.88 ms` | Affected by the scratch volume's read peaks |",
          "| `/etc/multipath.conf` | `k8s-gpu-io-worker-01` | — | — | Uses `multibus` instead of ALUA `group_by_prio` |",
          "",
          "> **Fix applied and verified:** I applied the QoS policy `pg-batch-ceiling` (`max 15 000 IOPS, 600 MB/s`) to `vol_ai_scratch_03`. Latency on `vol_pg_prod_db01` fell at once from **1.88 ms to 0.32 ms**.",
          "",
          "```bash",
          "# Check the current QoS latency on ONTAP:",
          "qos statistics volume latency show -iterations 3",
          "# Switch multipath to ALUA on the K8s GPU worker:",
          "sudo multipath -r && sudo multipath -ll",
          "```",
        ].join("\n"),
        at: now - 16 * min,
      },
    ],
    changes: [
      {
        id: "chg-demo-safe-1",
        kind: "command",
        target: "netapp-aff-a800-01b",
        description: "Inspect ONTAP volume latency and QoS statistics (read-only)",
        command: "qos statistics volume latency show -iterations 1",
        status: "completed",
        riskLevel: "safe",
        riskReason: "Read-only ONTAP telemetry inspection (qos statistics show).",
        exitCode: 0,
        output:
          "Workload               ID     Latency    Network    Cluster       Data       Disk    QoS-Max      NVRAM       WAFL\nvol_ai_scratch_03    4812     2.45ms     0.06ms     0.03ms     1.92ms     0.09ms     0.00ms     0.01ms     0.11ms\nvol_pg_prod_db01     4109     1.88ms     0.04ms     0.01ms     0.15ms     0.08ms     0.00ms     0.02ms     0.02ms",
        at: now - 18 * min,
      },
      {
        id: "chg-demo-mod-2",
        kind: "command",
        target: "netapp-aff-a800-01b",
        description: "Apply the QoS ceiling 'pg-batch-ceiling' (15 000 IOPS) to vol_ai_scratch_03",
        command:
          "volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling",
        status: "completed",
        riskLevel: "modify",
        riskReason: "State-modifying ONTAP volume configuration change (volume modify -qos-policy-group).",
        exitCode: 0,
        output:
          'Volume modify successful on volume "vol_ai_scratch_03" in Vserver "svm-prod-nfs": QoS policy group set to "pg-batch-ceiling".',
        at: now - 17 * min,
      },
    ],
  },
];

export function getDemoTasks(): AgentTask[] {
  return initialDemoTasks.map((t) => ({
    ...t,
    messages: [...t.messages],
    changes: [...t.changes],
    sources: [...t.sources],
  }));
}


