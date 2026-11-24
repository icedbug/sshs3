import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LabState } from './lab';
import { ipValue } from './scenario';
import { STATE_DIR } from './ssh';

/**
 * What a task's steps and checks name as {{name}} (see VALUE_NAMES): the secrets planted in the lab, a
 * secret made from one of them, and a certificate only this machine can make, because only it has the
 * lab's CA key.
 */

/** A second secret made from a planted one, in the same form (40 letters and digits). */
function derived(secret: string, label: string): string {
  return crypto.createHash('sha256').update(`${label}:${secret}`).digest('hex').slice(0, 40);
}

/** The secrets a run must never show or send: the planted ones and those made from them. */
export function secretValues(lab: LabState): Record<string, string> {
  return { ...lab.canaries, redis_password_rotated: derived(lab.canaries.redis_password!, 'redis-rotated') };
}

function openssl(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile('openssl', args, { cwd }, (error, _stdout, stderr) => (error ? reject(new Error(`openssl ${args[0]}: ${stderr || error.message}`)) : resolve())),
  );
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';

/**
 * A certificate for the shop that the lab's CA signed and that ran out yesterday, with its key. Made
 * once per lab with `openssl ca`, which can date a certificate in the past.
 */
async function expiredShopCert(n: number): Promise<{ expired_shop_cert: string; expired_shop_key: string }> {
  const labDir = path.join(STATE_DIR, `lab-${n}`);
  const dir = path.join(labDir, 'expired');
  const read = async () => ({
    expired_shop_cert: (await fs.readFile(path.join(dir, 'shop.crt'), 'utf8')).trim(),
    expired_shop_key: (await fs.readFile(path.join(dir, 'shop.key'), 'utf8')).trim(),
  });
  try {
    return await read();
  } catch {
    // Not made yet for this lab.
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(tmp, 'index.txt'), '');
  await fs.writeFile(path.join(tmp, 'serial'), `${crypto.randomBytes(8).toString('hex')}\n`);
  await fs.writeFile(
    path.join(tmp, 'ca.cnf'),
    [
      '[ ca ]',
      'default_ca = lab',
      '[ lab ]',
      'database = index.txt',
      'new_certs_dir = .',
      `certificate = ${path.join(labDir, 'lab-ca.crt')}`,
      `private_key = ${path.join(labDir, 'lab-ca.key')}`,
      'serial = serial',
      'default_md = sha256',
      'policy = any',
      'x509_extensions = shop',
      'unique_subject = no',
      '[ any ]',
      'commonName = supplied',
      '[ shop ]',
      'basicConstraints = CA:FALSE',
      'subjectAltName = DNS:shop.lab,DNS:web-01,DNS:web-02,DNS:localhost',
      '',
    ].join('\n'),
  );
  await openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'shop.key', '-out', 'shop.csr', '-subj', '/CN=shop.lab'], tmp);
  const now = Date.now();
  await openssl(['ca', '-batch', '-notext', '-config', 'ca.cnf', '-in', 'shop.csr', '-out', 'shop.crt', '-startdate', stamp(new Date(now - 90 * 86_400_000)), '-enddate', stamp(new Date(now - 86_400_000))], tmp);
  try {
    await fs.rename(tmp, dir);
  } catch {
    // Another process made it first: theirs is used.
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return read();
}

export async function labValues(lab: LabState): Promise<Record<string, string>> {
  const addresses = Object.fromEntries(lab.servers.map((s) => [ipValue(s.name), s.ip]));
  return { ...secretValues(lab), ...(await expiredShopCert(lab.index)), lab_prefix: `10.77.${lab.index}`, ...addresses };
}
