import type {
  AgentSchedule,
  MemoryEntry,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import type { S3Config } from "../../../shared/types/storage";
import type { Snippet } from "../../../shared/types/snippets";

let demoOverride: boolean | undefined;

export function setDemoMode(enabled: boolean): void {
  demoOverride = enabled;
  process.env.SSHS3_DEMO = enabled ? "1" : "0";
}

export function isDemoMode(): boolean {
  if (demoOverride !== undefined) return demoOverride;
  return (
    process.env.SSHS3_DEMO === "1" ||
    process.argv.includes("--demo")
  );
}

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
      "NetApp AFF A800 All-Flash HA-nod A (ONTAP 9.15.1) i Stockholm DC1. Äger aggr1_nvme_prod (220 TB NVMe) och betjänar SVM:erna svm-prod-nfs (NFSv4.1), svm-prod-iscsi (iSCSI/NVMe-oF) samt FabricPool S3-tiering mot StorageGRID.",
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
      "NetApp AFF A800 All-Flash HA-partner B (ONTAP 9.15.1). Äger aggr2_nvme_db (180 TB NVMe) för PostgreSQL/Oracle-LUN:ar, FlexGroup-volymer för AI-träning och synkron MetroCluster/SnapMirror-replikering.",
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
      "NetApp FAS9000 Hybrid Flash DR & SnapVault-kluster i Uppsala DC2 (1.6 PB NLSAS + NVMe FlashPool). Tar emot XDP SnapMirror var 15:e minut från AFF A800 med SnapLock Compliance mot ransomware.",
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
      "NetApp Active IQ Unified Manager 9.14 + NetApp Harvest 24.05 + Prometheus/Grafana för realtidsmätning av ONTAP IOPS, QoS-latens, WAFL NVRAM och volymtillväxt.",
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
      "NetApp StorageGRID 11.8 Primary Admin & High-Availability Load Balancer (S3 HTTPS :10443). Styr ILM-livscykelregler, S3 Object Lock (WORM), S3-buckets och FabricPool-kopplingen från ONTAP.",
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
      "NetApp StorageGRID SG6060 Storage Node 01 (Stockholm DC1) — 60x 드라이브 + NVMe metadata-cache. Kör RangedDB och geo-distribuerad Erasure Coding (6+3) över Stockholm och Uppsala.",
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
      "NetApp StorageGRID SG6060 Storage Node 02 (Stockholm DC1). Hanterar S3 multipart uploads för pgBackRest, Loki-loggsegment och ONTAP FabricPool cold blocks.",
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
      "MinIO AIStor All-NVMe S3-nod (4x 100GbE RDMA) för höghastighetsläsning av LLM-checkpoints och parquet-datasets med automatisk tiering ned till NetApp StorageGRID.",
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
      "Ceph Reef (18.2.4) Monitor, Active Manager & RADOS Gateway (RGW). Styr 420 TB NVMe RBD-blockpool för KVM/OpenStack och Rook-Ceph CSI med CRUSH-regler per rack.",
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
      "Ceph BlueStore OSD-nod 01 (16x 15.36TB Gen5 NVMe, osd.0–osd.15) med dual 100GbE RoCEv2 klusternätverk och dedikerade RocksDB WAL/DB-partitioner.",
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
      "TrueNAS Enterprise ZFS-lagringsnod (zpool: tank_backup_01, 1.4 PB RAIDZ3 + Optane SLOG & 2TB L2ARC) för immutable ZFS-snapshots, zfs send/recv och Restic/Veeam-arkiv.",
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
      "Kubernetes 1.31 Control Plane med NetApp Astra Trident CSI 24.06 (namespace: trident). Dynamisk provisionering av PVC:er mot ontap-nas (NFSv4.1), ontap-san (iSCSI/NVMe-oF) och ontap-nas-flexgroup.",
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
      "Kubernetes GPU & High-IOPS Worker-nod. Monterar NetApp FlexGroup-volymer med NFSv4.1 nconnect=8, pNFS/session trunking och DM-Multipath iSCSI/NVMe-oF.",
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
      "Dedikerad Storage Engineering Jump-host med NetApp ONTAP Ansible-playbooks, tridentctl, s3cmd, aws-cli, rclone, fio-benchmarks och Brocade SAN-zoning-skript.",
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
    secretAccessKey: "demo-secret-not-shared",
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
    secretAccessKey: "demo-secret-not-shared",
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
    secretAccessKey: "demo-secret-not-shared",
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
    secretAccessKey: "demo-secret-not-shared",
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
      "Utökade ONTAP FlexVol 'vol_k8s_pvc_prod' i svm-prod-nfs från 12TB till 16TB och slog på FabricPool auto-tiering (snapshot-only, min-cooling-days 14)",
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
      "AI-diagnostik identifierade en noisy-neighbor på 'vol_analytics_scratch' (48 000 IOPS lästopp) och satte QoS-policy 'pg-batch-ceiling' (max 15 000 IOPS) så att PostgreSQL-latensen på aggr2_nvme_db sjönk från 4.8 ms till 0.35 ms",
    detail:
      "qos statistics volume latency show -iterations 3 && volume modify -vserver svm-prod-iscsi -volume vol_analytics_scratch -qos-policy-group pg-batch-ceiling",
    at: now - 19 * min,
  },
  {
    id: "demo-act-trident-csi",
    profileId: "demo-k8s-storage-cp-01",
    targetLabel: "k8s-storage-cp-01",
    actor: "erik@acme.se",
    kind: "deploy",
    summary:
      "Uppdaterade NetApp Astra Trident backend 'tbc-ontap-nas-flexgroup' och rullade ut StorageClass 'ontap-flexgroup-ai' med mountOptions: nfsvers=4.1,nconnect=8,noatime",
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
      "Uppdaterade StorageGRID ILM-policy 'ILM-Prod-FabricPool-EC63' för Erasure Coding 6+3 över DC1/DC2 och verifierade S3 Object Lock-compliance på bucket 'ontap-fabricpool-tier'",
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
      "Verifierade SnapMirror XDP-replikering till Uppsala DC2 (netapp-fas9000-dr-01): alla 28 relationer är 'Snapmirrored' med lag-time < 4 minuter och SnapLock WORM-retention aktiv",
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
      "Åtgärdade Ceph HEALTH_WARN (2 PGs not deep-scrubbed in time) på pool 'rbd-nvme-prod' och justerade osd_max_backfills=2 under kontorstid",
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
      "Uppdaterade /etc/multipath.conf för NetApp LUN ALUA (path_grouping_policy group_by_prio, rr_min_io_rq 1) och laddade om multipathd",
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
      "Kontrollerade ZFS pool health på 'tank_backup_01' (ONLINE, 0 errors, 71% cap, compressionratio 2.41x LZ4) och rensade utgångna temporära snapshots äldre än 90 dagar",
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
    scope: "workspace",
    title: "NetApp AFF A800 (NetApp-ONTAP-Prod-SE) — Aggregat, SVM:er & LIF-topologi",
    text: [
      "Kluster: `NetApp-ONTAP-Prod-SE` (ONTAP 9.15.1) i Stockholm DC1 består av HA-paret `netapp-aff-a800-01a` (10.30.10.11) och `netapp-aff-a800-01b` (10.30.10.12).",
      "- `aggr1_nvme_prod` (Nod A, 220 TB NVMe RAID-TEC): Primär lagring för `svm-prod-nfs` (Kubernetes Astra Trident NFSv4.1 PVC:er och delade filsystem).",
      "- `aggr2_nvme_db` (Nod B, 180 TB NVMe RAID-TEC): Låglatens-lagring (< 0.5 ms) för `svm-prod-iscsi` (PostgreSQL/Oracle iSCSI & NVMe/TCP namespaces) samt `svm-prod-s3`.",
      "- Kalla snapshots och inaktiva block flyttas automatiskt via **NetApp FabricPool** till `NetApp-StorageGRID-S3` (`ontap-fabricpool-tier`) efter 14 dagar.",
    ].join("\n"),
    author: "erik@acme.se",
    updatedAt: now - 8 * min,
  },
  {
    id: "demo-mem-snapmirror-dr",
    kind: "memory",
    scope: "workspace",
    title: "NetApp SnapMirror XDP & SnapLock Ransomware-skydd (Uppsala DC2)",
    text: [
      "Alla produktionsvolymer på `netapp-aff-a800-01a/01b` replikeras med **SnapMirror XDP** var 15:e minut till `netapp-fas9000-dr-01` (10.30.20.11, SVM `svm-dr-uppsala`).",
      "- Snapshot-policy `pol-prod-ransomware-safe` tar timvisa snapshots med **Tamperproof Snapshot Locking** i 14 dagar och dagliga SnapVault-kopior i 90 dagar.",
      "- Vid larm om hög `lag-time` (> 30 min): kontrollera intercluster-LIF:arna `ic-dc1-01a` / `ic-dc2-01a` på VLAN 3090 (MTU 9000 Jumbo Frames).",
    ].join("\n"),
    author: "erik@acme.se",
    updatedAt: now - 34 * min,
  },
  {
    id: "demo-mem-storagegrid-s3",
    kind: "memory",
    scope: "workspace",
    title: "NetApp StorageGRID 11.8 & MinIO AIStor — S3 Objektlagring & ILM",
    text: [
      "Objektlagringsklustret `NetApp-StorageGRID-S3` styrs via `sg-admin-primary-01` (10.30.30.10, S3-endpoint `https://s3-dc1.storage.acme.se:10443`) med lagringsnoderna `sg-sn-nvme-01` och `sg-sn-nvme-02`.",
      "- ILM-policyn `ILM-Prod-FabricPool-EC63` använder Erasure Coding 6+3 över DC1/DC2.",
      "- För AI/ML-träningsjobb används `minio-aistor-edge-01` (10.30.30.40:9000, bucket `llm-checkpoints-prod`) som NVMe-cache med automatisk tiering till StorageGRID.",
    ].join("\n"),
    author: "sara@acme.se",
    updatedAt: now - 26 * min,
  },
  {
    id: "demo-mem-trident-csi",
    kind: "memory",
    scope: "workspace",
    title: "Kubernetes Astra Trident CSI 24.06 — StorageClasses & Multipath",
    text: [
      "Kubernetes-klustret `K8s-Trident-CSI-Prod` (`k8s-storage-cp-01`, `k8s-gpu-io-worker-01`) använder NetApp Astra Trident i namespace `trident`:",
      "- `ontap-nas-premium`: `ontap-nas`-drivrutin mot `svm-prod-nfs` (NFSv4.1, `nconnect=8`).",
      "- `ontap-flexgroup-ai`: `ontap-nas-flexgroup` för parallell högkapacitets-I/O från GPU-workers.",
      "- `ontap-san-nvme`: `ontap-san`-drivrutin med iSCSI / NVMe-oF och ALUA `group_by_prio` i `/etc/multipath.conf`.",
    ].join("\n"),
    author: "jacob",
    updatedAt: now - 22 * min,
  },
  {
    id: "demo-mem-ceph-truenas",
    kind: "memory",
    scope: "workspace",
    title: "Ceph Reef NVMe-pool & TrueNAS ZFS Immutable Backup",
    text: [
      "Klustret `Ceph-NVMe-Block-Pool` (`ceph-mon-mgr-01` 10.30.40.10, `ceph-osd-nvme-01` 10.30.40.21) levererar RBD-blocklagring (`rbd-nvme-prod`, replika 3x, min_size 2) över 100GbE RoCEv2.",
      "`truenas-zfs-vault-01` (10.30.40.50) håller ZFS-poolen `tank_backup_01` (1.4 PB RAIDZ3 + Optane SLOG) för nattliga ZFS-replikeringar och Restic/Veeam-arkiv.",
    ].join("\n"),
    author: "linnea@acme.se",
    updatedAt: now - 42 * min,
  },

  // ─── Shared Workspace Skills / Storage Runbooks ───────────────────────
  {
    id: "demo-skill-ontap-latency",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: Felsök hög I/O-latens i NetApp ONTAP (QoS, WAFL & NVRAM)",
    text: [
      "1. Identifiera vilken komponent i ONTAP som orsakar latensen (Network, Cluster-Interconnect, Disk, WAFL eller QoS ceiling):",
      "   `qos statistics volume latency show -iterations 5 -rows 15`",
      "2. Hitta 'noisy neighbor'-volymer med högst IOPS/throughput:",
      "   `qos statistics volume performance show -iterations 5`",
      "3. Kontrollera aggregatets diskutnyttjande och CPU/WAFL-belastning per HA-nod:",
      "   `system node run -node netapp-aff-a800-01* -command sysstat -x 1`",
      "4. Begränsa en stökig batch-/scratch-volym direkt med en QoS-policy:",
      "   `volume modify -vserver <svm> -volume <vol> -qos-policy-group pg-batch-ceiling`",
    ].join("\n"),
    author: "sara@acme.se",
    updatedAt: now - 19 * min,
  },
  {
    id: "demo-skill-snapmirror-lag",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: NetApp SnapMirror Lag / Broken-Off Resync & DR-verifiering",
    text: [
      "1. Lista alla SnapMirror-relationer som har `lag-time > 30m` eller `healthy: false`:",
      "   `snapmirror show -healthy false -fields source-path,destination-path,state,status,lag-time,last-transfer-error`",
      "2. Verifiera att Intercluster-LIF:ar kan nå varandra med MTU 9000:",
      "   `cluster peer ping -aca true` och `network interface show -role intercluster`",
      "3. Trigga en manuell inkrementell uppdatering eller resync:",
      "   `snapmirror update -destination-path svm-dr-uppsala:<vol_dest>`",
      "   (Om `Broken-off`: `snapmirror resync -destination-path svm-dr-uppsala:<vol_dest>`)",
    ].join("\n"),
    author: "erik@acme.se",
    updatedAt: now - 34 * min,
  },
  {
    id: "demo-skill-trident-pvc",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: Felsök Kubernetes Astra Trident PVC i Pending / AttachError",
    text: [
      "1. Inspektera PVC-events och Trident-controllerns loggar på `k8s-storage-cp-01`:",
      "   `kubectl describe pvc <pvc-namn> -n <ns>`",
      "   `tridentctl logs -n trident -l trident-operator`",
      "2. Kontrollera att alla ONTAP-backends i Trident har status `online`:",
      "   `tridentctl get backend -n trident`",
      "3. Vid iSCSI `Multi-Attach` eller `AttachError` på `k8s-gpu-io-worker-01`, verifiera `iscsid` och multipath:",
      "   `sudo iscsiadm -m session -P 3 && sudo multipath -ll`",
      "4. Vid NFSv4.1 mount-timeout, verifiera export-policyn i ONTAP:",
      "   `vserver export-policy rule show -vserver svm-prod-nfs -policyname trid_export_prod`",
    ].join("\n"),
    author: "erik@acme.se",
    updatedAt: now - 22 * min,
  },
  {
    id: "demo-skill-storagegrid-ilm",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: NetApp StorageGRID S3 Hälsokontroll, ILM-kö & FabricPool-tiering",
    text: [
      "1. På `sg-admin-primary-01`, kontrollera nodstatus och aktiva larm i StorageGRID:",
      "   `storagegrid-status` och `curl -sk https://localhost:10443/health`",
      "2. Kontrollera från ONTAP (`netapp-aff-a800-01a`) att FabricPool object-store-target är `available`:",
      "   `storage aggregate object-store show -fields object-store-name,availability,unavailable-reason`",
      "3. Testa S3-svarstid och lista buckets via `san-bastion-jump-01`:",
      "   `aws --endpoint-url https://s3-dc1.storage.acme.se:10443 s3 ls`",
    ].join("\n"),
    author: "sara@acme.se",
    updatedAt: now - 26 * min,
  },
  {
    id: "demo-skill-ceph-health",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: Ceph HEALTH_WARN (Slow Ops, Nearfull OSD & PG Scrubbing)",
    text: [
      "1. Kontrollera klusterhälsa och detaljerade varningar på `ceph-mon-mgr-01`:",
      "   `ceph status && ceph health detail`",
      "2. Lista OSD-utnyttjande och identifiera obalanserade NVMe-diskar:",
      "   `ceph osd df tree` och `ceph df detail`",
      "3. Vid `SLOW_OPS`: identifiera blockerade OSD:er och kontrollera NVMe-latens:",
      "   `ceph daemon osd.<id> dump_historic_slow_ops`",
      "4. Om rebalansering påverkar produktions-I/O, dämpa backfill-takten tillfälligt:",
      "   `ceph config set osd osd_max_backfills 1 && ceph config set osd osd_recovery_max_active 1`",
    ].join("\n"),
    author: "linnea@acme.se",
    updatedAt: now - 42 * min,
  },
];

const initialDemoSchedules: AgentSchedule[] = [
  {
    id: "demo-sched-ontap-health",
    title: "NetApp ONTAP Aggregat, Volymkapacitet & QoS-latens (var 30:e min)",
    prompt:
      "Kontrollera storage failover status, aggregat > 80% fyllnadsgrad, volymer nära kvotgräns samt om någon SVM-volym har QoS-latens över 2 ms på @netapp-aff-a800-01a och @netapp-aff-a800-01b.",
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
    title: "SnapMirror XDP RPO & SnapLock-verifiering (varje timme)",
    prompt:
      "Verifiera på @netapp-fas9000-dr-01 att alla SnapMirror-relationer har healthy=true och lag-time under 30 minuter. Rapportera avvikelser i teamets aktivitetslogg.",
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
    title: "StorageGRID S3 FabricPool & Ceph NVMe Pool Health (var 2:a timme)",
    prompt:
      "Kontrollera S3-endpointstatus och ILM-köer på @sg-admin-primary-01 samt `ceph health detail` och `ceph df` på @ceph-mon-mgr-01.",
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
    name: "ONTAP: Top Volume Latency & IOPS (QoS)",
    command: "qos statistics volume latency show -iterations 5 -rows 15",
  },
  {
    id: "demo-snip-ontap-aggr-vol",
    name: "ONTAP: Aggregate & FlexVol Capacity (>75%)",
    command:
      "storage aggregate show -fields size,usedsize,percent-used,state && volume show -percent-used >75 -fields vserver,volume,size,avail,percent-used,tiering-policy",
  },
  {
    id: "demo-snip-ontap-snapmirror",
    name: "ONTAP: SnapMirror Health & Lag-Time",
    command:
      "snapmirror show -fields source-path,destination-path,state,status,healthy,lag-time",
  },
  {
    id: "demo-snip-trident-status",
    name: "K8s Trident CSI: Backends, StorageClasses & PVCs",
    command:
      "tridentctl get backend -n trident && kubectl get sc,pvc -A -o wide",
  },
  {
    id: "demo-snip-ceph-health",
    name: "Ceph: Cluster Status, OSD Utilization & Pool DF",
    command: "ceph -s && ceph osd df tree && ceph df detail",
  },
  {
    id: "demo-snip-zfs-status",
    name: "TrueNAS ZFS: Pool Health, ARC Stats & Snapshots",
    command:
      "zpool status -v && zfs list -o name,used,avail,refer,compressratio,mountpoint",
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
    description: input.description?.trim() || undefined,
    role: input.role?.trim() || undefined,
    tags: input.tags?.length ? input.tags : undefined,
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
