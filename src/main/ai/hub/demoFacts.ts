import type { WorkspaceServerSummary } from "../../../shared/types/aiHub";

/**
 * What a demo server "prints" when its facts are read, in the form the real
 * script prints, so the same parser and the same diff are shown. The second
 * and later readings differ from the first, so that there is something under
 * "Changed recently" without a real server.
 */
export function demoFactsOutput(server: Pick<WorkspaceServerSummary, "name" | "host">, now: number, generation: number): string {
  // A storage appliance has a shell of its own: it does not answer the script, and is shown as such.
  if (/netapp|aff-|fas\d|storagegrid|sg-\d|ontap/i.test(server.name)) return 'Error: "export" is not a recognized command';
  const seed = [...server.name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7);
  // Not every server changes between two readings, and those that do change differently.
  const later = generation > 0 && seed % 3 !== 1;
  const upgraded = later && seed % 2 === 0;
  const filling = later && seed % 4 === 0;
  const db = /pg|db|sql/i.test(server.name);
  const hash = (text: string): string => [...Array(64)].map((_, i) => ((text.charCodeAt(i % text.length) * (i + 3) + seed) % 16).toString(16)).join("");
  const days = (n: number): string => {
    const d = new Date(now + n * 86_400_000);
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    return `${month} ${String(d.getUTCDate()).padStart(2, " ")} 12:00:00 ${d.getUTCFullYear()} GMT`;
  };
  return [
    "@@sshs3:begin",
    "@@sshs3:os",
    'NAME="Ubuntu"',
    'VERSION_ID="24.04"',
    'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
    "@@sshs3:kernel",
    `Linux 6.8.0-${upgraded ? 49 : 45}-generic x86_64`,
    "@@sshs3:hostname",
    server.name,
    "@@sshs3:uptime",
    // Up since a fixed moment, so that a server which did not restart does not look as if it had.
    `${upgraded ? 3600 : Math.max(3600, Math.round((now - Date.UTC(2026, 8, 1 + (seed % 28))) / 1000))}.11 1000.00`,
    "@@sshs3:pkg-dpkg",
    `openssl 3.0.13-0ubuntu3.${upgraded ? 5 : 4}`,
    `openssh-server 1:9.6p1-3ubuntu13.5`,
    db ? `postgresql-16 16.${later ? 6 : 4}-0ubuntu0.24.04.1` : `nginx 1.${later ? "26.1-1" : "24.0-2ubuntu7"}`,
    "curl 8.5.0-2ubuntu10.4",
    "@@sshs3:failed",
    ...(later && seed % 3 === 0 ? ["logrotate.service loaded failed failed Rotate log files"] : []),
    "@@sshs3:running",
    "ssh.service loaded active running OpenBSD Secure Shell server",
    "cron.service loaded active running Regular background program processing daemon",
    db ? "postgresql@16-main.service loaded active running PostgreSQL Cluster 16-main" : "nginx.service loaded active running A high performance web server",
    "@@sshs3:listen-tcp",
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=812,fd=3))',
    db ? 'LISTEN 0 200 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=1203,fd=6))' : 'LISTEN 0 511 0.0.0.0:443 0.0.0.0:* users:(("nginx",pid=1410,fd=7))',
    ...(later && !db ? ['LISTEN 0 511 0.0.0.0:8443 0.0.0.0:* users:(("nginx",pid=1410,fd=9))'] : []),
    "@@sshs3:listen-udp",
    "@@sshs3:peers",
    "@@sshs3:disks",
    "Filesystem Type 1024-blocks Used Available Capacity Mounted on",
    `/dev/sda1 ext4 61255492 ${filling ? 56000000 : 30000000} 5000000 ${filling ? 91 + (seed % 5) : 48 + (seed % 20)}% /`,
    `/dev/sdb1 xfs 209715200 100000000 109715200 ${40 + (seed % 30)}% /var/lib/data`,
    "@@sshs3:reboot",
    ...(upgraded && seed % 4 === 2 ? ["required"] : []),
    "@@sshs3:certs",
    ...(db ? [] : [`/etc/letsencrypt/live/${server.name}/cert.pem|notAfter=${days(seed % 5 === 0 ? 9 : 60 + (seed % 200))}|subject=CN = ${server.name}.example.com|`]),
    "@@sshs3:files",
    `${hash("sshd")}  /etc/ssh/sshd_config`,
    `${hash("hosts")}  /etc/hosts`,
    db ? `${hash(later ? "pg2" : "pg1")}  /etc/postgresql/16/main/postgresql.conf` : `${hash(later ? "ngx2" : "ngx1")}  /etc/nginx/nginx.conf`,
    "@@sshs3:end",
  ].join("\n");
}
