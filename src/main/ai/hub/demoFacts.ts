import type { WorkspaceServerSummary } from "../../../shared/types/aiHub";

/** One believable system per row: the release, its kernels before and after an upgrade, and its packages. */
interface DemoOs {
  name: string;
  version: string;
  pretty: string;
  kernel: [string, string];
  pkg: "dpkg" | "rpm";
  openssl: [string, string];
  openssh: string;
  curl: string;
  postgres: [string, string, string];
  nginx: [string, string];
  /** The unit names differ between the Debian and the Red Hat families. */
  ssh: string;
  cron: string;
  pgUnit: string;
  pgConf: string;
}

const DEMO_OS: DemoOs[] = [
  {
    name: "Ubuntu",
    version: "24.04",
    pretty: "Ubuntu 24.04.1 LTS",
    kernel: ["6.8.0-45-generic", "6.8.0-49-generic"],
    pkg: "dpkg",
    openssl: ["3.0.13-0ubuntu3.4", "3.0.13-0ubuntu3.5"],
    openssh: "1:9.6p1-3ubuntu13.5",
    curl: "8.5.0-2ubuntu10.4",
    postgres: ["postgresql-16", "16.4-0ubuntu0.24.04.1", "16.6-0ubuntu0.24.04.1"],
    nginx: ["1.24.0-2ubuntu7", "1.24.0-2ubuntu7.1"],
    ssh: "ssh.service loaded active running OpenBSD Secure Shell server",
    cron: "cron.service loaded active running Regular background program processing daemon",
    pgUnit: "postgresql@16-main.service loaded active running PostgreSQL Cluster 16-main",
    pgConf: "/etc/postgresql/16/main/postgresql.conf",
  },
  {
    name: "Ubuntu",
    version: "22.04",
    pretty: "Ubuntu 22.04.5 LTS",
    kernel: ["5.15.0-122-generic", "5.15.0-125-generic"],
    pkg: "dpkg",
    openssl: ["3.0.2-0ubuntu1.18", "3.0.2-0ubuntu1.19"],
    openssh: "1:8.9p1-3ubuntu0.10",
    curl: "7.81.0-1ubuntu1.18",
    postgres: ["postgresql-14", "14.13-0ubuntu0.22.04.1", "14.15-0ubuntu0.22.04.1"],
    nginx: ["1.18.0-6ubuntu14.4", "1.18.0-6ubuntu14.5"],
    ssh: "ssh.service loaded active running OpenBSD Secure Shell server",
    cron: "cron.service loaded active running Regular background program processing daemon",
    pgUnit: "postgresql@14-main.service loaded active running PostgreSQL Cluster 14-main",
    pgConf: "/etc/postgresql/14/main/postgresql.conf",
  },
  {
    name: "Debian GNU/Linux",
    version: "12",
    pretty: "Debian GNU/Linux 12 (bookworm)",
    kernel: ["6.1.0-25-amd64", "6.1.0-28-amd64"],
    pkg: "dpkg",
    openssl: ["3.0.14-1~deb12u2", "3.0.15-1~deb12u1"],
    openssh: "1:9.2p1-2+deb12u3",
    curl: "7.88.1-10+deb12u8",
    postgres: ["postgresql-15", "15.8-0+deb12u1", "15.10-0+deb12u1"],
    nginx: ["1.22.1-9", "1.22.1-9+deb12u1"],
    ssh: "ssh.service loaded active running OpenBSD Secure Shell server",
    cron: "cron.service loaded active running Regular background program processing daemon",
    pgUnit: "postgresql@15-main.service loaded active running PostgreSQL Cluster 15-main",
    pgConf: "/etc/postgresql/15/main/postgresql.conf",
  },
  {
    name: "Rocky Linux",
    version: "9.4",
    pretty: "Rocky Linux 9.4 (Blue Onyx)",
    kernel: ["5.14.0-427.13.1.el9_4.x86_64", "5.14.0-427.42.1.el9_4.x86_64"],
    pkg: "rpm",
    openssl: ["3.0.7-27.el9", "3.0.7-28.el9_4"],
    openssh: "8.7p1-38.el9_4.4",
    curl: "7.76.1-29.el9_4.1",
    postgres: ["postgresql-server", "13.14-1.el9_3", "13.16-1.el9_4"],
    nginx: ["1.20.1-14.el9_2.1", "1.20.1-16.el9_4.1"],
    ssh: "sshd.service loaded active running OpenSSH server daemon",
    cron: "crond.service loaded active running Command Scheduler",
    pgUnit: "postgresql.service loaded active running PostgreSQL database server",
    pgConf: "/var/lib/pgsql/data/postgresql.conf",
  },
];

/** What a server is for, read from its name: the service it runs, the port it listens on, the file that is watched. */
interface DemoRole {
  /** The package row, before and after a later reading. */
  pkg: (os: DemoOs, later: boolean) => string;
  unit: (os: DemoOs) => string;
  listen: string;
  conf: (os: DemoOs) => string;
  cert?: (name: string) => string;
}

const ROLES: { match: RegExp; role: DemoRole }[] = [
  {
    match: /pg|db|sql/i,
    role: {
      pkg: (os, later) => `${os.postgres[0]} ${os.postgres[later ? 2 : 1]}`,
      unit: (os) => os.pgUnit,
      listen: 'LISTEN 0 200 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=1203,fd=6))',
      conf: (os) => os.pgConf,
    },
  },
  {
    match: /k8s|kube/i,
    role: {
      pkg: (os, later) => (os.pkg === "rpm" ? `kubelet 1.30.${later ? 6 : 4}-150500.1.1` : `kubelet 1.30.${later ? 6 : 4}-1.1`),
      unit: () => "kubelet.service loaded active running kubelet: The Kubernetes Node Agent",
      listen: 'LISTEN 0 4096 *:10250 *:* users:(("kubelet",pid=1105,fd=14))',
      conf: () => "/var/lib/kubelet/config.yaml",
    },
  },
  {
    match: /ceph/i,
    role: {
      pkg: (os, later) => (os.pkg === "rpm" ? `ceph-common 18.2.${later ? 4 : 2}-0.el9` : `ceph-common 18.2.${later ? 4 : 2}-1`),
      unit: () => "ceph-crash.service loaded active running Ceph crash dump collector",
      listen: 'LISTEN 0 512 0.0.0.0:6789 0.0.0.0:* users:(("ceph-mon",pid=1320,fd=27))',
      conf: () => "/etc/ceph/ceph.conf",
    },
  },
  {
    match: /minio/i,
    role: {
      pkg: (os, later) => `minio 20240${later ? "913" : "716"}234046.0.0${os.pkg === "rpm" ? "-1" : ""}`,
      unit: () => "minio.service loaded active running MinIO",
      listen: 'LISTEN 0 4096 *:9000 *:* users:(("minio",pid=1288,fd=9))',
      conf: () => "/etc/default/minio",
      cert: () => "/etc/minio/certs/public.crt",
    },
  },
  {
    match: /bastion|jump/i,
    role: {
      pkg: (os, later) => (os.pkg === "rpm" ? `fail2ban 1.0.2-${later ? 12 : 7}.el9` : `fail2ban 1.0.2-${later ? 3 : 2}`),
      unit: () => "fail2ban.service loaded active running Fail2Ban Service",
      listen: 'LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=812,fd=4))',
      conf: () => "/etc/fail2ban/jail.local",
    },
  },
];

const WEB: DemoRole = {
  pkg: (os, later) => `nginx ${os.nginx[later ? 1 : 0]}`,
  unit: () => "nginx.service loaded active running A high performance web server",
  listen: 'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=1410,fd=7))',
  conf: () => "/etc/nginx/nginx.conf",
  cert: (name) => `/etc/letsencrypt/live/${name}/cert.pem`,
};

/** Storage appliances (ONTAP, StorageGRID, TrueNAS) have a shell of their own that does not run the script. */
const APPLIANCE = /netapp|aff-|fas\d|storagegrid|(^|[^a-z])sg-|ontap|truenas/i;

/**
 * What a demo server "prints" when its facts are read, in the form the real
 * script prints, so the same parser and the same diff are shown. The second
 * and later readings differ from the first, so that there is something under
 * "Changed recently" without a real server.
 */
export function demoFactsOutput(server: Pick<WorkspaceServerSummary, "name" | "host">, now: number, generation: number): string {
  // An appliance does not answer the script, and is shown as such.
  if (APPLIANCE.test(server.name)) return 'Error: "export" is not a recognized command';
  const seed = [...server.name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7);
  // Not every server changes between two readings, and those that do change differently.
  const later = generation > 0 && seed % 3 !== 1;
  const upgraded = later && seed % 2 === 0;
  const filling = later && seed % 4 === 0;
  // A fleet is never all one release: the name picks the row, so a server keeps its system between readings.
  const os = DEMO_OS[Math.floor(seed / 7) % DEMO_OS.length];
  const role = ROLES.find((r) => r.match.test(server.name))?.role ?? WEB;
  const conf = role.conf(os);
  const cert = role.cert?.(server.name);
  const hash = (text: string): string => [...Array(64)].map((_, i) => ((text.charCodeAt(i % text.length) * (i + 3) + seed) % 16).toString(16)).join("");
  const days = (n: number): string => {
    const d = new Date(now + n * 86_400_000);
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    return `${month} ${String(d.getUTCDate()).padStart(2, " ")} 12:00:00 ${d.getUTCFullYear()} GMT`;
  };
  return [
    "@@sshs3:begin",
    "@@sshs3:os",
    `NAME="${os.name}"`,
    `VERSION_ID="${os.version}"`,
    `PRETTY_NAME="${os.pretty}"`,
    "@@sshs3:kernel",
    `Linux ${os.kernel[upgraded ? 1 : 0]} x86_64`,
    "@@sshs3:hostname",
    server.name,
    "@@sshs3:uptime",
    // Up since a fixed moment, so that a server which did not restart does not look as if it had.
    `${upgraded ? 3600 : Math.max(3600, Math.round((now - Date.UTC(2026, 8, 1 + (seed % 28))) / 1000))}.11 1000.00`,
    `@@sshs3:pkg-${os.pkg}`,
    `openssl ${os.openssl[upgraded ? 1 : 0]}`,
    `openssh-server ${os.openssh}`,
    role.pkg(os, later),
    `curl ${os.curl}`,
    "@@sshs3:failed",
    ...(later && seed % 3 === 0 ? ["logrotate.service loaded failed failed Rotate log files"] : []),
    "@@sshs3:running",
    os.ssh,
    os.cron,
    role.unit(os),
    "@@sshs3:listen-tcp",
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))',
    role.listen,
    ...(later && role === WEB ? ['LISTEN 0 511 0.0.0.0:8443 0.0.0.0:* users:(("nginx",pid=1410,fd=9))'] : []),
    "@@sshs3:listen-udp",
    "@@sshs3:peers",
    "@@sshs3:disks",
    "Filesystem Type 1024-blocks Used Available Capacity Mounted on",
    `/dev/sda1 ext4 61255492 ${filling ? 56000000 : 30000000} 5000000 ${filling ? 91 + (seed % 5) : 48 + (seed % 20)}% /`,
    `/dev/sdb1 xfs 209715200 100000000 109715200 ${40 + (seed % 30)}% /var/lib/data`,
    "@@sshs3:reboot",
    ...(upgraded && seed % 4 === 2 ? ["required"] : []),
    "@@sshs3:certs",
    // A certificate close to its end is rare: about one name in forty, and of the demo lab's own servers exactly one.
    ...(cert ? [`${cert}|notAfter=${days(seed % 41 === 20 ? 9 : 60 + (seed % 200))}|subject=CN = ${server.name}.example.com|`] : []),
    "@@sshs3:files",
    `${hash("sshd")}  /etc/ssh/sshd_config`,
    `${hash("hosts")}  /etc/hosts`,
    `${hash(later ? "conf2" : "conf1")}  ${conf}`,
    "@@sshs3:end",
  ].join("\n");
}
