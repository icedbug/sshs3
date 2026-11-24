import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STATE_DIR } from './ssh';

/**
 * The lab's own certificate authority, and the model proxy's certificate signed by it. A shared sshs3
 * server reaches a model on another address only over https, so the proxy answers over https, and the
 * web server is told to trust this CA, as an organisation trusts its own. Made once and kept in
 * lab/.state/model-proxy; nothing here leaves this machine.
 */

const DIR = path.join(STATE_DIR, 'model-proxy');
/** This machine on its own, and its gateway address on every lab network (10.77.<n>.1). */
const ADDRESSES = ['127.0.0.1', ...Array.from({ length: 250 }, (_, i) => `10.77.${i + 1}.1`)];

function openssl(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile('openssl', args, { cwd }, (error, _stdout, stderr) => (error ? reject(new Error(`openssl ${args[0]}: ${stderr || error.message}`)) : resolve())),
  );
}

async function make(dir: string): Promise<void> {
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  await openssl(['req', '-x509', ...ec, '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-subj', '/CN=sshs3 lab CA for the model proxy', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], dir);
  await openssl(['req', ...ec, '-keyout', 'proxy.key', '-out', 'proxy.csr', '-subj', '/CN=sshs3 lab model proxy'], dir);
  await fs.writeFile(
    path.join(dir, 'proxy.ext'),
    ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', 'extendedKeyUsage=serverAuth', `subjectAltName=${ADDRESSES.map((a) => `IP:${a}`).join(',')}`, ''].join('\n'),
  );
  await openssl(['x509', '-req', '-in', 'proxy.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'proxy.crt', '-days', '3650', '-extfile', 'proxy.ext'], dir);
  await fs.rm(path.join(dir, 'ca.key'));
}

export async function labTls(): Promise<{ key: string; cert: string; caPath: string }> {
  const read = async () => ({
    key: await fs.readFile(path.join(DIR, 'proxy.key'), 'utf8'),
    cert: await fs.readFile(path.join(DIR, 'proxy.crt'), 'utf8'),
    caPath: path.join(DIR, 'ca.crt'),
  });
  try {
    return await read();
  } catch {
    // Not made yet.
  }
  // Made beside the place it goes and moved in whole, so a second lab process never reads half of it.
  const tmp = `${DIR}.tmp-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
  await make(tmp);
  try {
    await fs.rename(tmp, DIR);
  } catch {
    // Another process made it first: theirs is used.
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return read();
}

/**
 * A file of the certificates the web server is to trust beyond its usual ones: the lab's CA, and those
 * this machine already adds (NODE_EXTRA_CA_CERTS), which the setting would otherwise replace.
 */
export async function trustBundle(): Promise<string> {
  const { caPath } = await labTls();
  const extra = process.env.NODE_EXTRA_CA_CERTS ? await fs.readFile(process.env.NODE_EXTRA_CA_CERTS, 'utf8').catch(() => '') : '';
  const bundle = path.join(DIR, 'trust.pem');
  const tmp = `${bundle}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${(await fs.readFile(caPath, 'utf8')).trim()}\n${extra.trim() ? `${extra.trim()}\n` : ''}`);
  await fs.rename(tmp, bundle);
  return bundle;
}
