import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parsePolicyConf, parseRegQueryOutput, registryValuesToRaw } from './policyParse';

const execFileAsync = promisify(execFile);

/** What a source found. `absent` is normal (no policy deployed); `error` means a policy may exist but cannot be trusted or read. */
export type PolicySourceResult =
  | { status: 'absent' }
  | { status: 'ok'; raw: unknown; warnings?: string[] }
  | { status: 'error'; message: string };

export interface PolicySource {
  name: string;
  read(): Promise<PolicySourceResult>;
}

const REGISTRY_KEY = 'HKLM\\SOFTWARE\\Policies\\sshs3';

/** Machine-wide, admin-only policy.conf locations. Windows has none: HKLM is the protected store there. */
export function policyFilePath(platform: NodeJS.Platform): string | null {
  if (platform === 'linux') return '/etc/sshs3/policy.conf';
  if (platform === 'darwin') return '/Library/Application Support/sshs3/policy.conf';
  return null;
}

export function registryPolicyKey(): string {
  return REGISTRY_KEY;
}

/** Absolute path, so a `reg.exe` planted earlier on PATH can never answer for the machine's policy. */
export function systemRegExePath(env: NodeJS.ProcessEnv): string {
  return path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
}

/** Runs reg.exe with these arguments and returns its stdout. Replaceable in tests. */
export type RegRunner = (args: string[]) => Promise<string>;

function defaultRegRunner(env: NodeJS.ProcessEnv): RegRunner {
  // latin1 keeps every byte as one character: reg.exe writes in the console codepage, which is not UTF-8.
  return async (args) =>
    (await execFileAsync(systemRegExePath(env), args, { timeout: 10000, windowsHide: true, encoding: 'latin1' })).stdout;
}

const NON_ASCII = /[^\x20-\x7e]/;
const POLICIES_PARENT = 'HKLM\\SOFTWARE\\Policies';
const OWN_KEY_LINE = /^HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\sshs3\s*$/im;

/**
 * Windows: `HKLM\SOFTWARE\Policies\sshs3`, written by GPO / Intune / `reg add`. Readable without admin rights.
 *
 * `reg query` exits 1 both when the key does not exist and when it cannot be read, and its message is localized.
 * The two are told apart by looking for the key among its parent's subkeys, which needs no access to the key itself.
 * Text values are accepted as ASCII only: the console codepage reg.exe writes in cannot be known here.
 */
export function createRegistrySource(env: NodeJS.ProcessEnv = process.env, run: RegRunner = defaultRegRunner(env)): PolicySource {
  return {
    name: `registry ${REGISTRY_KEY}`,
    async read() {
      let stdout: string;
      try {
        stdout = await run(['query', REGISTRY_KEY, '/reg:64']);
      } catch (err) {
        if ((err as { code?: unknown }).code !== 1) {
          return { status: 'error', message: `Could not read ${REGISTRY_KEY}: ${(err as Error).message}` };
        }
        try {
          const listing = await run(['query', POLICIES_PARENT, '/f', 'sshs3', '/k', '/e', '/reg:64']);
          return OWN_KEY_LINE.test(listing)
            ? { status: 'error', message: `${REGISTRY_KEY} exists but could not be read (access denied?).` }
            : { status: 'absent' };
        } catch (listErr) {
          // No match, or no Policies key at all: nothing is deployed. Anything else is a real failure.
          return (listErr as { code?: unknown }).code === 1
            ? { status: 'absent' }
            : { status: 'error', message: `Could not read ${REGISTRY_KEY}: ${(listErr as Error).message}` };
        }
      }
      const values = parseRegQueryOutput(stdout);
      const warnings: string[] = [];
      for (const [name, value] of Object.entries(values)) {
        if (typeof value === 'string' && NON_ASCII.test(value)) {
          warnings.push(`Policy "${name}" ignored: registry text values must contain ASCII characters only.`);
          delete values[name];
        }
      }
      return { status: 'ok', raw: registryValuesToRaw(values), warnings };
    },
  };
}

export interface PolicyFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}

/** Why a policy file must not be trusted, or null if it is root-owned and writable by root only. */
export function describeUntrustedPolicyFile(stat: PolicyFileStat): string | null {
  if (stat.isSymbolicLink()) return 'it is a symbolic link';
  if (!stat.isFile()) return 'it is not a regular file';
  if (stat.uid !== 0) return 'it is not owned by root';
  if ((stat.mode & 0o022) !== 0) return 'it is writable by group or others';
  return null;
}

/**
 * Why the folder holding the policy must not be trusted, or null if only root can change what is in it. A folder
 * an ordinary user owns would let them delete the file, which silently removes the policy.
 */
export function describeUntrustedPolicyDir(stat: PolicyFileStat): string | null {
  if (stat.isSymbolicLink()) return 'its folder is a symbolic link';
  if (!stat.isDirectory()) return 'its folder is not a directory';
  if (stat.uid !== 0) return 'its folder is not owned by root';
  if ((stat.mode & 0o022) !== 0) return 'its folder is writable by group or others';
  return null;
}

/** The file operations the file source needs, so tests can stand in for the disk. */
export interface PolicyFileIo {
  lstat(path: string): Promise<PolicyFileStat>;
  open(
    path: string,
    flags: number
  ): Promise<{ stat(): Promise<PolicyFileStat>; readFile(encoding: 'utf-8'): Promise<string>; close(): Promise<void> }>;
}

const diskIo: PolicyFileIo = {
  lstat: (p) => fsPromises.lstat(p),
  open: (p, flags) => fsPromises.open(p, flags),
};

/**
 * Linux / macOS: a root-owned policy.conf in a root-owned folder, so no ordinary user could have planted, edited or
 * removed it. The file is opened once (never following a symlink) and the trust check is made on that open file, so
 * it cannot be swapped between the check and the read.
 */
export function createFileSource(filePath: string, io: PolicyFileIo = diskIo): PolicySource {
  return {
    name: `file ${filePath}`,
    async read() {
      let handle;
      try {
        handle = await io.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { status: 'absent' };
        if (code === 'ELOOP') return { status: 'error', message: `Ignoring ${filePath}: it is a symbolic link.` };
        return { status: 'error', message: `Could not read ${filePath}: ${(err as Error).message}` };
      }
      try {
        const untrusted =
          describeUntrustedPolicyFile(await handle.stat()) ?? describeUntrustedPolicyDir(await io.lstat(path.dirname(filePath)));
        if (untrusted) return { status: 'error', message: `Ignoring ${filePath}: ${untrusted}.` };
        const { raw, warnings } = parsePolicyConf(await handle.readFile('utf-8'));
        return { status: 'ok', raw, warnings };
      } catch (err) {
        return { status: 'error', message: `Could not read ${filePath}: ${(err as Error).message}` };
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}

/** The protected policy sources for a platform, most authoritative first. Pure, so every OS is testable anywhere. */
export function getPolicySources(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): PolicySource[] {
  if (platform === 'win32') return [createRegistrySource(env)];
  const file = policyFilePath(platform);
  return file ? [createFileSource(file)] : [];
}
