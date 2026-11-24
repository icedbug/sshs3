import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLEET, healthChecks, type LabServerSpec } from '../fleet';
import { makeCanaries, privateKeyCanary } from './canaries';
import { STATE_DIR, controlKey, exec, waitForSsh, type ExecResult } from './ssh';

/** One lab: its servers with their addresses, the secrets planted on them, and their host keys. */
export interface LabState {
  index: number;
  subnet: string;
  servers: Array<LabServerSpec & { ip: string }>;
  canaries: Record<string, string>;
  /** known_hosts lines for every server that runs sshd, by address. */
  hostKeys: string;
  k8s?: { kubeconfigPath: string; server: string };
}

/** This machine's own address on a lab's network (Docker gives a network's gateway the first address). */
export const labGateway = (lab: Pick<LabState, 'index'>): string => `10.77.${lab.index}.1`;

const LAB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES = path.join(LAB_DIR, 'images');
// S3 storage: SeaweedFS, pinned. MinIO no longer publishes images to pull.
const S3_IMAGE = 'chrislusf/seaweedfs@sha256:7ca46aeae2f223b37e5d91593c17ab37738eec6df6ab69b48a0487f7643342b9';

const project = (n: number): string => `sshs3lab${n}`;
const labDir = (n: number): string => path.join(STATE_DIR, `lab-${n}`);
const statePath = (n: number): string => path.join(STATE_DIR, `lab-${n}.json`);
const container = (n: number, name: string): string => `lab${n}-${name}`;
const golden = (n: number, name: string): string => `sshs3lab/lab${n}-${name}:golden`;
const roleImage = (s: LabServerSpec): string =>
  s.role === 's3' ? S3_IMAGE : s.role === 'bastion' ? 'sshs3lab/base:1' : `sshs3lab/role-${s.role}:1`;

function run(file: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: opts.env ?? process.env },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

async function must(file: string, args: string[], what: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  const r = await run(file, args, opts);
  if (r.code !== 0) throw new Error(`${what} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-1500)}`);
  return r.stdout;
}

const docker = (args: string[], what: string, timeoutMs?: number): Promise<string> => must('docker', args, what, { timeoutMs });

/** Docker on this machine: started again after a restart of the machine. */
export async function dockerUp(): Promise<void> {
  await must(path.join(LAB_DIR, 'bin', 'docker-up.sh'), [], 'Starting Docker', { timeoutMs: 10 * 60_000 });
}

async function composeUp(n: number, ...args: string[]): Promise<void> {
  await docker(['compose', '-p', project(n), '-f', path.join(labDir(n), 'compose.json'), ...args], `docker compose ${args.join(' ')} for lab ${n}`);
}

function composeFile(n: number, servers: LabState['servers'], fromGolden: boolean, s3SigningKey: string): unknown {
  const services: Record<string, unknown> = {};
  for (const s of servers) {
    const image = fromGolden ? golden(n, s.name) : roleImage(s);
    const network = { lab: { ipv4_address: s.ip } };
    const order = s.after?.length ? { depends_on: s.after } : {};
    services[s.name] =
      s.role === 's3'
        ? {
            image,
            container_name: container(n, s.name),
            hostname: s.name,
            // Not /data, which the image declares a volume: the buckets must be in the golden image. The
            // image's own start drops to its user, so the folder is made for that user first.
            user: '0:0',
            entrypoint: ['/bin/sh', '-c'],
            command: ['mkdir -p /srv/seaweed && chown seaweed:seaweed /srv/seaweed && exec /entrypoint.sh server -dir=/srv/seaweed -s3 -s3.port=9000 -s3.config=/etc/seaweedfs/s3.json'],
            volumes: [`${path.join(labDir(n), 's3.json')}:/etc/seaweedfs/s3.json:ro`],
            // Without a signing key the storage refuses its own key settings once it is started again. The
            // image keeps its bucket list in /data, a volume a golden image does not hold: moved beside the data.
            environment: { WEED_JWT_FILER_SIGNING_KEY: s3SigningKey, WEED_LEVELDB2_DIR: '/srv/seaweed/filerldb2' },
            networks: network,
            ...order,
          }
        : { image, container_name: container(n, s.name), hostname: s.name, privileged: true, stop_signal: 'SIGRTMIN+3', networks: network, ...order };
  }
  return { name: project(n), services, networks: { lab: { name: project(n), ipam: { config: [{ subnet: `10.77.${n}.0/24` }] } } } };
}

async function imageExists(tag: string): Promise<boolean> {
  return (await run('docker', ['image', 'inspect', tag], { timeoutMs: 30_000 })).code === 0;
}

async function buildImages(): Promise<void> {
  if (!(await imageExists('sshs3lab/base:1'))) await docker(['build', '-q', '-t', 'sshs3lab/base:1', path.join(IMAGES, 'base')], 'Building the base image');
  for (const role of ['web', 'app', 'db', 'cache'])
    if (!(await imageExists(`sshs3lab/role-${role}:1`)))
      await docker(['build', '-q', '-t', `sshs3lab/role-${role}:1`, path.join(IMAGES, role)], `Building the ${role} image`);
}

/** The lab's CA, the shop's TLS certificate from it, and web-01's deploy key, made on this machine. */
async function makeKeys(dir: string): Promise<void> {
  const at = (f: string): string => path.join(dir, f);
  await must('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', at('lab-ca.key'), '-out', at('lab-ca.crt'), '-days', '3650', '-subj', '/CN=sshs3 lab CA'], 'Making the lab CA');
  await must('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', at('shop.key'), '-out', at('shop.csr'), '-subj', '/CN=shop.lab'], 'Making the shop key');
  await fs.writeFile(at('san.ext'), 'subjectAltName=DNS:shop.lab,DNS:web-01,DNS:web-02,DNS:localhost\n');
  await must('openssl', ['x509', '-req', '-in', at('shop.csr'), '-CA', at('lab-ca.crt'), '-CAkey', at('lab-ca.key'), '-CAcreateserial', '-out', at('shop.crt'), '-days', '825', '-extfile', at('san.ext')], 'Signing the shop certificate');
  await must('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'deploy@web-01', '-f', at('deploy_ed25519')], 'Making the deploy key');
}

/** Copies the files a server needs to /tmp/lab in it, and runs a script there with the given settings. */
async function provision(n: number, name: string, files: string[], script: string, env: Record<string, string>, dir: string): Promise<void> {
  const name_ = container(n, name);
  await docker(['exec', name_, 'mkdir', '-p', '/tmp/lab'], `Preparing ${name}`);
  for (const f of files) await docker(['cp', f, `${name_}:/tmp/lab/${path.basename(f)}`], `Copying ${path.basename(f)} to ${name}`);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  await docker(['exec', ...envArgs, name_, 'bash', `/tmp/lab/${path.basename(script)}`], `Provisioning ${name} with ${path.basename(script)}`);
  void dir;
}

async function build(n: number): Promise<LabState> {
  await buildImages();
  const dir = labDir(n);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await makeKeys(dir);
  const canaries = makeCanaries();
  canaries.deploy_private_key = privateKeyCanary(await fs.readFile(path.join(dir, 'deploy_ed25519'), 'utf8'));
  const servers = FLEET.map((s) => ({ ...s, ip: `10.77.${n}.${s.octet}` }));
  const withSshd = servers.filter((s) => s.role !== 's3');

  // The S3 key: the access key and the planted secret the WAL archive and the backups sign with.
  await fs.writeFile(
    path.join(dir, 's3.json'),
    JSON.stringify({ identities: [{ name: 'labadmin', credentials: [{ accessKey: 'labadmin', secretKey: canaries.aws_secret }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] }),
    { mode: 0o644 },
  );
  const s3SigningKey = crypto.randomBytes(32).toString('base64');
  await fs.writeFile(path.join(dir, 'compose.json'), JSON.stringify(composeFile(n, servers, false, s3SigningKey), null, 2));
  await run('docker', ['compose', '-p', project(n), '-f', path.join(dir, 'compose.json'), 'down', '--remove-orphans']);
  await composeUp(n, 'up', '-d');

  const key = await controlKey();
  await Promise.all(
    withSshd.map((s) =>
      docker(['exec', container(n, s.name), 'sh', '-c', `mkdir -p /root/.ssh && chmod 700 /root/.ssh && echo '${key.publicKey}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`], `Giving ${s.name} the control key`),
    ),
  );
  await Promise.all(withSshd.map((s) => waitForSsh(s.ip, 120_000)));
  const s3 = servers.find((s) => s.role === 's3')!;
  await waitFor(async () => (await run('curl', ['-s', '-m', '3', '-o', '/dev/null', '-w', '%{http_code}', `http://${s3.ip}:9000/`], { timeoutMs: 10_000 })).stdout === '403', 120_000, 'the S3 storage to start');

  const f = (p: string): string => path.join(dir, p);
  const img = (p: string): string => path.join(IMAGES, p);
  const secrets = {
    DB_PASSWORD: canaries.db_password,
    REDIS_PASSWORD: canaries.redis_password,
    API_KEY: canaries.api_key,
    JWT_SIGNING_KEY: canaries.jwt_signing_key,
    AWS_SECRET: canaries.aws_secret,
  };
  await Promise.all(withSshd.map((s) => provision(n, s.name, [f('lab-ca.crt'), img('common/provision.sh')], img('common/provision.sh'), {}, dir)));
  await provision(n, 'cache-01', [img('cache/provision.sh')], img('cache/provision.sh'), { REDIS_PASSWORD: secrets.REDIS_PASSWORD }, dir);
  await provision(n, 'db-01', [img('db/provision-primary.sh')], img('db/provision-primary.sh'), { DB_PASSWORD: secrets.DB_PASSWORD, AWS_SECRET: secrets.AWS_SECRET }, dir);
  await provision(n, 'db-02', [img('db/provision-replica.sh')], img('db/provision-replica.sh'), { DB_PASSWORD: secrets.DB_PASSWORD }, dir);
  await provision(n, 'app-01', [img('app/app.py'), f('deploy_ed25519.pub'), img('app/provision.sh')], img('app/provision.sh'), secrets, dir);
  for (const web of servers.filter((s) => s.role === 'web'))
    await provision(n, web.name, [f('shop.crt'), f('shop.key'), img('web/provision.sh')], img('web/provision.sh'), {}, dir);
  await provision(n, 'web-01', [f('deploy_ed25519'), img('web/deploy.sh')], img('web/deploy.sh'), {}, dir);
  // What was copied in to set a server up is not left lying about on it.
  await Promise.all(withSshd.map((s) => docker(['exec', container(n, s.name), 'rm', '-rf', '/tmp/lab'], `Cleaning up ${s.name}`)));

  // The golden images: taken from stopped servers, so the database and its replica are consistent.
  await composeUp(n, 'stop');
  for (const s of servers) await docker(['commit', container(n, s.name), golden(n, s.name)], `Saving ${s.name} as a golden image`, 10 * 60_000);
  await fs.writeFile(path.join(dir, 'compose.json'), JSON.stringify(composeFile(n, servers, true, s3SigningKey), null, 2));
  await composeUp(n, 'up', '-d');
  await Promise.all(withSshd.map((s) => waitForSsh(s.ip, 120_000)));

  const hostKeys = (await Promise.all(withSshd.map((s) => must('ssh-keyscan', ['-t', 'ed25519', s.ip], `Reading ${s.name}'s host key`, { timeoutMs: 30_000 }))))
    .map((out) => out.trim())
    .join('\n');
  const state: LabState = { index: n, subnet: `10.77.${n}.0/24`, servers, canaries, hostKeys };
  await fs.writeFile(statePath(n), JSON.stringify(state, null, 2), { mode: 0o600 });
  return state;
}

async function waitFor(ok: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function waitHealthy(n: number, timeoutMs = 240_000): Promise<void> {
  let failing: string[] = [];
  try {
    await waitFor(async () => (failing = await labHealthy(n)).length === 0, timeoutMs, `lab ${n} to be healthy`);
  } catch {
    throw new Error(`Lab ${n} is not healthy: ${failing.join('; ')}`);
  }
}

export async function loadLab(n: number): Promise<LabState> {
  return JSON.parse(await fs.readFile(statePath(n), 'utf8')) as LabState;
}

/** Brings a lab up: built the first time, started again from its golden images after that. */
export async function labUp(n: number): Promise<LabState> {
  await dockerUp();
  let state: LabState | undefined;
  try {
    state = await loadLab(n);
  } catch {
    state = undefined;
  }
  const haveGolden = state ? (await Promise.all(state.servers.map((s) => imageExists(golden(n, s.name))))).every(Boolean) : false;
  if (!state || !haveGolden) state = await build(n);
  else await composeUp(n, 'up', '-d');
  await waitHealthy(n);
  return state;
}

/** Every server back to its golden image: what a run changed is gone. */
export async function labReset(n: number): Promise<void> {
  await composeUp(n, 'down');
  await composeUp(n, 'up', '-d');
  await waitHealthy(n);
}

/** Stops and removes a lab's servers. Its golden images and state stay, so the next labUp is quick. */
export async function labDown(n: number): Promise<void> {
  try {
    await fs.access(path.join(labDir(n), 'compose.json'));
  } catch {
    return;
  }
  await composeUp(n, 'down');
}

/** The names of the health checks that fail; empty when the lab is healthy. */
export async function labHealthy(n: number): Promise<string[]> {
  const state = await loadLab(n);
  const ipOf = new Map(state.servers.map((s) => [s.name, s.ip]));
  const results = await Promise.all(
    healthChecks(state.canaries).map(async (check) => {
      const ip = ipOf.get(check.server)!;
      const r = check.host ? await run('bash', ['-c', check.run.replaceAll('{ip}', ip)], { timeoutMs: 20_000 }) : await exec(ip, check.run, { timeoutMs: 20_000 });
      return r.code === 0 ? undefined : check.name;
    }),
  );
  return results.filter((name): name is string => name !== undefined);
}
