import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseCertificateDer, type SmartcardCertificateDetails } from './CertificateParser';
import { withPkcs11Lock } from './Pkcs11Lock';
import { createLogger } from '../log';
const smartcardCertLog = createLogger('smartcard-cert');

const log = (...args: unknown[]) => smartcardCertLog.warn('', ...args);
const execFileAsync = promisify(execFile);

/** Same resolution `proxyCli.cjs` uses (see SmartcardDetector's proxy handling): `__dirname` is
 * either this source file's own directory (`src/main/smartcard`, dev/unbundled — `certWorker.cjs`
 * already lives right there) or the flattened build output directory (`dist-electron`, packaged —
 * where the vite plugin copies `certWorker.cjs` alongside the bundled main process). Either way
 * it's a sibling of this file. */
function resolveWorkerPath(): string {
  const currentDir =
    typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, 'certWorker.cjs');
}

/**
 * Reads every X.509 certificate object off a PKCS#11 token and returns its
 * parsed details, keyed by the SSH fingerprint of its public key.
 *
 * Talks to the PKCS#11 module directly (same `.so`/`.dll` already resolved
 * for `ssh-add -s <path>`) instead of shelling out to a vendor CLI tool
 * (e.g. OpenSC's `pkcs11-tool`) — that tool isn't installed at all for
 * providers like Net iD, which ship only the PKCS#11 library itself. Since
 * PKCS#11 is a standard C API, this works identically regardless of which
 * provider (OpenSC, Net iD, p11-kit-proxy) is behind `pkcs11LibPath`.
 *
 * Certificate objects are public on essentially every PIV/CAC/SITHS/Net iD
 * card, so this deliberately never logs in (`C_Login`) — no PIN prompt.
 * Returns an empty map on any failure (missing module, no card inserted,
 * unreadable objects, ...) rather than throwing, since this is purely
 * supplementary display info for an already-working identity list — but
 * every failure is logged with `console.warn`, since silently returning
 * nothing gave no way to diagnose why a given card's details don't show up.
 *
 * The actual PKCS#11 calls run in a short-lived child process (`certWorker.cjs`), not inline
 * here: some vendor modules (observed with Net iD's libiidp11.so) raise a native SIGTRAP inside
 * `C_Finalize()` when this runs in the same process that also holds the token open elsewhere
 * (e.g. the app-lifetime agent loaded via `ssh-add -s` for 'agent-global' mode, which is exactly
 * when this function is called — see getOrLoadGlobalSmartcardAgent). That's a native-level crash;
 * no in-process try/catch can catch a SIGTRAP, and it took down the whole Electron main process.
 * Isolating it in a worker means a crash there only kills the worker — this function just gets an
 * empty result and logs it, the same as any other failure to read certs.
 */
export async function readSmartcardCertificates(
  pkcs11LibPath: string
): Promise<Map<string, SmartcardCertificateDetails>> {
  const results = new Map<string, SmartcardCertificateDetails>();

  let certsBase64: string[] | undefined;
  try {
    // See Pkcs11Lock's doc comment: this must never race a concurrent `ssh-add -s` (or another
    // cert read) against the same physical token.
    const stdout = await withPkcs11Lock(() => runCertWorker(pkcs11LibPath));
    const line = stdout.trim().split('\n').pop() ?? '';
    const parsed: { certs?: string[]; error?: string } = JSON.parse(line);
    if (parsed.error) {
      log(`certWorker reported an error for ${pkcs11LibPath}:`, parsed.error);
    } else {
      certsBase64 = parsed.certs ?? [];
    }
  } catch (err) {
    log(`certWorker failed for ${pkcs11LibPath}:`, err);
  }

  if (certsBase64 === undefined && process.platform === 'win32') {
    // The native `pkcs11js` addon needs a compiler toolchain (Python + MSVC) to build, so it is
    // frequently missing on Windows. OpenSC ships `pkcs11-tool.exe` next to its PKCS#11 module, which
    // reads the same public certificate objects without a PIN — use it when it's there.
    try {
      certsBase64 = await withPkcs11Lock(() => readCertsViaPkcs11Tool(pkcs11LibPath));
      log(`${pkcs11LibPath}: read ${certsBase64.length} certificate(s) via pkcs11-tool fallback`);
    } catch (err) {
      log(`pkcs11-tool fallback failed for ${pkcs11LibPath}:`, err);
    }
  }

  if (certsBase64 === undefined) return results;

  for (const derBase64 of certsBase64) {
    try {
      const details = parseCertificateDer(Buffer.from(derBase64, 'base64'));
      if (details) {
        results.set(details.fingerprint, details);
      } else {
        log('found a certificate but could not parse it or derive an SSH fingerprint for it (unsupported key type?)');
      }
    } catch (err) {
      log('failed to parse a certificate returned by certWorker:', err);
    }
  }

  log(`${pkcs11LibPath}: resolved ${results.size} certificate(s) with a usable fingerprint`);
  return results;
}

/**
 * Whether the module reports a token in any slot (`C_GetSlotList(tokenPresent)`), without a PIN.
 * `undefined` when that can't be told (worker unavailable or failed): callers then proceed as if a
 * token were there rather than blocking a card that works.
 */
export async function isSmartcardTokenPresent(pkcs11LibPath: string): Promise<boolean | undefined> {
  try {
    const stdout = await withPkcs11Lock(() => runCertWorker(pkcs11LibPath));
    const parsed: { tokenPresent?: boolean; error?: string } = JSON.parse(stdout.trim().split('\n').pop() ?? '');
    if (parsed.error) return undefined;
    return typeof parsed.tokenPresent === 'boolean' ? parsed.tokenPresent : undefined;
  } catch {
    return undefined;
  }
}

/** Finds OpenSC's `pkcs11-tool.exe` for a module path like `...\OpenSC\pkcs11\opensc-pkcs11.dll`
 * (the tool lives in the sibling `tools` directory), or undefined when this isn't an OpenSC install. */
function findPkcs11Tool(pkcs11LibPath: string): string | undefined {
  const candidates = [
    path.resolve(path.dirname(pkcs11LibPath), '..', 'tools', 'pkcs11-tool.exe'),
    'C:\\Program Files\\OpenSC Project\\OpenSC\\tools\\pkcs11-tool.exe',
    'C:\\Program Files (x86)\\OpenSC Project\\OpenSC\\tools\\pkcs11-tool.exe',
  ];
  return candidates.find((c) => existsSync(c));
}

/** Reads every X.509 certificate object off the token with `pkcs11-tool` (no PIN needed) and
 * returns each one's DER, base64-encoded, matching what certWorker.cjs reports. */
async function readCertsViaPkcs11Tool(pkcs11LibPath: string): Promise<string[]> {
  const tool = findPkcs11Tool(pkcs11LibPath);
  if (!tool) throw new Error('pkcs11-tool.exe not found next to the PKCS#11 module');

  const { stdout: listing } = await execFileAsync(tool, ['--module', pkcs11LibPath, '-O', '--type', 'cert'], {
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  // The object ID is printed like "ID:         1 (0x01)" — prefer the hex in parentheses.
  const ids = [...listing.matchAll(/^\s*ID:\s+(?:\S+\s+\(0x([0-9a-fA-F]+)\)|([0-9a-fA-F]+))/gm)].map(
    (m) => m[1] ?? m[2]
  );

  const certs: string[] = [];
  for (const id of new Set(ids)) {
    const { stdout } = await execFileAsync(
      tool,
      ['--module', pkcs11LibPath, '--read-object', '--type', 'cert', '--id', id],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }
    );
    // A DER certificate is an ASN.1 SEQUENCE (0x30); anything else is diagnostic noise, not a cert.
    if (stdout.length > 0 && stdout[0] === 0x30) {
      certs.push(stdout.toString('base64'));
    }
  }
  return certs;
}

function runCertWorker(pkcs11LibPath: string): Promise<string> {
  const workerPath = resolveWorkerPath();
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [workerPath, pkcs11LibPath],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout) => {
        // The worker may still exit non-zero or be killed (e.g. by the vendor module's
        // C_Finalize crash) *after* it already wrote its JSON result line — treat any non-empty
        // stdout as usable even if the process itself ended badly.
        if (stdout && stdout.trim().length > 0) {
          resolve(stdout);
          return;
        }
        reject(err ?? new Error('certWorker produced no output'));
      }
    );
  });
}
