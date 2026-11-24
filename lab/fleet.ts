/**
 * The servers of one lab: the production of a small company, one container each. A lab n has the
 * subnet 10.77.<n>.0/24, and a server's address there is its octet.
 */
export type Role = 'bastion' | 'web' | 'app' | 'db' | 'cache' | 's3';

export interface LabServerSpec {
  name: string;
  role: Role;
  octet: number;
  tags: string[];
  description: string;
  /** The user a person logs in as. */
  user: string;
  /**
   * The servers that start before this one. nginx refuses to start when the name of its upstream does
   * not resolve yet, as on any network where a host is not up.
   */
  after?: string[];
}

export const FLEET: LabServerSpec[] = [
  { name: 'bastion-01', role: 'bastion', octet: 10, tags: ['infra'], description: 'Jump host for the shop network.', user: 'ops' },
  { name: 'web-01', role: 'web', octet: 21, tags: ['production', 'web'], description: 'nginx in front of the shop API, TLS for shop.lab.', user: 'ops', after: ['app-01'] },
  { name: 'web-02', role: 'web', octet: 22, tags: ['staging', 'web'], description: 'Staging copy of the shop front.', user: 'ops', after: ['app-01'] },
  { name: 'app-01', role: 'app', octet: 31, tags: ['production', 'app'], description: 'The shop API (shop-api.service, Python) on port 8080.', user: 'ops', after: ['db-01', 'cache-01'] },
  { name: 'db-01', role: 'db', octet: 41, tags: ['production', 'database'], description: 'PostgreSQL 16 primary for the shop; WAL archived to s3-01.', user: 'ops', after: ['s3-01'] },
  { name: 'db-02', role: 'db', octet: 42, tags: ['production', 'database'], description: 'PostgreSQL 16 streaming replica of db-01.', user: 'ops', after: ['db-01'] },
  { name: 'cache-01', role: 'cache', octet: 51, tags: ['production', 'cache'], description: 'Redis for the shop API, with a password.', user: 'ops' },
  { name: 's3-01', role: 's3', octet: 61, tags: ['production', 'storage'], description: 'S3 storage (SeaweedFS): buckets wal-archive, backups and team.', user: 'ops' },
];

/** A check of a healthy lab. It runs on the server (or on this machine, with `host`); true when it exits 0. */
export interface HealthCheck {
  name: string;
  server: string;
  run: string;
  host?: boolean;
}

/** What a healthy lab looks like. `{ip}` in a host check is the server's address. */
export function healthChecks(canaries: Record<string, string>): HealthCheck[] {
  const checks: HealthCheck[] = [];
  for (const s of FLEET) {
    if (s.role === 'web')
      checks.push({ name: `${s.name}: nginx serves the shop`, server: s.name, run: "systemctl is-active --quiet nginx && curl -sk https://localhost/ | grep -q 'Shop'" });
    if (s.role === 'app')
      checks.push({ name: `${s.name}: shop-api answers healthy`, server: s.name, run: 'systemctl is-active --quiet shop-api && curl -sf http://localhost:8080/health >/dev/null' });
    if (s.name === 'db-01')
      checks.push({ name: 'db-01: postgres has the shop orders', server: s.name, run: `test "$(sudo -u postgres psql -tAc 'select count(*) from orders' shop)" -ge 10000` });
    if (s.name === 'db-02')
      checks.push({ name: 'db-02: the replica streams from db-01', server: s.name, run: `test "$(sudo -u postgres psql -tAc 'select status from pg_stat_wal_receiver')" = streaming` });
    if (s.role === 'cache')
      checks.push({ name: `${s.name}: redis answers with its password`, server: s.name, run: `test "$(redis-cli -a '${canaries.redis_password}' --no-auth-warning ping)" = PONG` });
    if (s.role === 's3')
      // Asked with the lab's key from db-01, the way the WAL archive reaches it.
      checks.push({ name: `${s.name}: the buckets answer with the lab's key`, server: 'db-01', run: 'rclone --config /etc/rclone/rclone.conf --contimeout 5s --timeout 15s lsd s3: | grep -q wal-archive' });
    if (s.role === 'bastion') checks.push({ name: `${s.name}: answers`, server: s.name, run: 'true' });
  }
  return checks;
}
