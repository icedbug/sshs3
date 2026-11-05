import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLifecycleManager } from '../ssh/AgentLifecycleManager';
import { AskpassServer, type AskpassPromptHandler } from './AskpassServer';
import {
  execWithPresenceDetection,
  listAgentIdentities,
  loadFido2ResidentKeysIntoPrivateAgent,
} from './SmartcardAgentLoader';
import { withPkcs11Lock } from './Pkcs11Lock';
import { isYkmanAvailable, listYkmanFidoCredentials, deleteYkmanFidoCredential } from './YkmanFido';
import { FIDO2_KEY_FILE_EXISTS_PREFIX, type Fido2KeyType, type Fido2ResidentKey, type GeneratedFido2Key } from '../../shared/types/ssh';

export interface GenerateFido2KeyOptions {
  outPath: string;
  keyType: Fido2KeyType;
  /** Discoverable credential: the key material itself lives on the token, not just a stub file on disk. */
  resident: boolean;
  /** Require a touch (and PIN, if the token has one set) for every signature, not just at generation time. */
  verifyRequired: boolean;
  /**
   * Deletes a pre-existing file at `outPath` (and its `.pub`) before
   * generating, instead of refusing. Meant for the common "I deleted this
   * resident credential from the device via ykman, but the local stub file
   * from when it was first generated is still sitting there" case — for a
   * resident key, that local file is just a disposable reference to the
   * on-device credential, not the key material itself, so overwriting it
   * loses nothing the device didn't already lose when the credential was
   * deleted. Never implied automatically; the caller's UI must get explicit
   * confirmation first.
   */
  overwrite?: boolean;
  promptHandler?: AskpassPromptHandler;
  onPresenceRequested?: () => void;
  onPresenceCleared?: () => void;
}

/**
 * Expands a leading `~` to the user's home directory. Neither Node's `fs`
 * module nor a directly-spawned `ssh-keygen` (no shell involved, so no
 * shell-side tilde expansion either) understand `~` on their own — passing
 * it through unexpanded silently created a literal `~/.ssh/...` directory
 * under the app's current working directory instead of the user's real home
 * directory. Every path this module touches must go through this first.
 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Runs `ssh-keygen -t <ed25519-sk|ecdsa-sk>` to create a new FIDO2 security
 * key-backed SSH key. Generation itself needs a physical touch (and the
 * token's PIN, if `-O verify-required` or the token requires one) exactly
 * like a live authentication does, so this reuses the same Askpass +
 * touch-detection plumbing as `loadSmartcardIntoPrivateAgent` rather than
 * inventing a second prompt path.
 *
 * Also goes through `withPkcs11Lock` (despite the PKCS#11-flavored name,
 * it's really just an app-wide "one physical token operation at a time"
 * queue): `ssh-keygen` opens its own exclusive USB/CTAP session against the
 * authenticator, same as `ssh-add -K`/`-s` does via `runAddIntoPrivateAgent`
 * — without sharing that lock, an in-flight resident-key scan (or another
 * generate) racing this call fights over the same physical device, and the
 * touch you give it can silently go to the wrong process or get lost
 * entirely, hanging with no visible error.
 */
export async function generateFido2Key(options: GenerateFido2KeyOptions): Promise<GeneratedFido2Key> {
  const outPath = expandHome(options.outPath);
  const dir = path.dirname(outPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const existing = await fs
    .stat(outPath)
    .then(() => true)
    .catch(() => false);
  if (existing) {
    if (!options.overwrite) {
      throw new Error(`${FIDO2_KEY_FILE_EXISTS_PREFIX} A file already exists at ${outPath}.`);
    }
    // ssh-keygen would otherwise hit its OWN interactive "Overwrite (y/n)?" prompt for the file
    // (distinct from the on-device "already exists" prompt execWithPresenceDetection's stdin.end()
    // already guards against) — remove it ourselves first so ssh-keygen never sees it there at all.
    await fs.rm(outPath, { force: true });
    await fs.rm(`${outPath}.pub`, { force: true });
  }

  const args = ['-t', options.keyType, '-f', outPath, '-N', ''];
  if (options.resident) {
    args.push('-O', 'resident');
    // Every resident credential is stored on the token scoped by an "application" string —
    // ssh-keygen defaults this to the bare "ssh:" for every key, so a second resident key
    // (generated for a different profile, or just a repeat test) collides with whatever's
    // already there under that same default scope and ssh-keygen falls back to an interactive
    // "Overwrite? (y/n)" stdin prompt we can never answer (see execWithPresenceDetection's
    // stdin.end() for why that no longer hangs forever). Scoping by the output filename keeps
    // distinct profiles' resident keys from colliding by default; regenerating at the exact same
    // path is still a deliberate overwrite and still fails fast with a clear error instead of
    // hanging.
    const label = path.basename(outPath).replace(/[^A-Za-z0-9_.-]/g, '_');
    args.push('-O', `application=ssh:${label}`);
  }
  if (options.verifyRequired) args.push('-O', 'verify-required');

  const askpassServer = new AskpassServer({ promptHandler: options.promptHandler ?? (() => '') });
  await askpassServer.start();

  try {
    const sshKeygenBin = process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen';
    const env = {
      ...process.env,
      ...askpassServer.getEnv(),
    };
    await withPkcs11Lock(() =>
      execWithPresenceDetection(sshKeygenBin, args, { env, timeoutMs: 120000 }, options.onPresenceRequested)
    );
  } finally {
    options.onPresenceCleared?.();
    await askpassServer.stop();
  }

  const publicKeyPath = `${outPath}.pub`;
  const publicKey = (await fs.readFile(publicKeyPath, 'utf-8')).trim();
  return { publicKey, privateKeyPath: outPath, publicKeyPath };
}

/** OpenSSH only ever creates resident credentials for a relying party starting with "ssh:" (`-O application=ssh:…`). */
function isSshCredential(credential: { rpId: string }): boolean {
  return credential.rpId.startsWith('ssh:');
}

/**
 * An empty PIN means the prompt was dismissed (or there was nothing to ask on). Running ykman with it
 * would send an empty PIN to the key (at best a pointless failure, at worst a counted wrong attempt).
 */
function requirePin(pin: string): void {
  if (!pin) throw new Error('PIN entry was cancelled');
}

/**
 * Lists the FIDO2 discoverable ("resident") credentials stored on whatever
 * security key is currently plugged in, without leaving any new key files
 * on disk and without keeping an agent running afterwards — this is a
 * one-shot "what's on this device" query, e.g. for a profile-setup UI to
 * let the user pick a credential rather than typing a file path.
 *
 * Prefers `ykman` (see YkmanFido.ts) when it's installed: it reports the
 * credential's actual `-O application=` scope (human-readable — usually the
 * output filename, see generateFido2Key) instead of a bare SSH key
 * fingerprint, and — critically — gives back a `credentialId`, which is
 * the only way to delete one specific credential later (`ssh-add` has no
 * concept of deleting a single resident credential from the device). Falls
 * back to the `ssh-add -K` + `ssh-add -l` route when `ykman` isn't present,
 * same as before — informational only, no delete capability.
 */
export async function listFido2ResidentKeys(
  promptHandler: AskpassPromptHandler,
  options?: { onPresenceRequested?: () => void; onPresenceCleared?: () => void }
): Promise<Fido2ResidentKey[]> {
  if (await isYkmanAvailable()) {
    const pin = await promptHandler("Enter your security key's PIN:");
    requirePin(pin);
    try {
      const creds = await listYkmanFidoCredentials(pin);
      return creds.filter(isSshCredential).map((c) => ({
        fingerprint: c.credentialId,
        comment: c.userDisplayName || c.userName || c.rpId,
        keyType: c.rpId,
        credentialId: c.credentialId,
      }));
    } catch (err) {
      // On Windows ykman talks to the FIDO device over raw HID, which only an elevated process
      // may do ("FIDO access on Windows requires running as Administrator"). Win32-OpenSSH goes
      // through the OS WebAuthn API instead, which needs no admin, so list via ssh-add -K below
      // (informational only — no credentialId, so individual deletion isn't offered).
      const message = err instanceof Error ? err.message : String(err);
      if (process.platform !== 'win32' || !/administrator/i.test(message)) throw err;
    }
  }

  const { pid, socketPath } = await loadFido2ResidentKeysIntoPrivateAgent(promptHandler, options);
  try {
    return await listAgentIdentities(socketPath);
  } finally {
    AgentLifecycleManager.killPrivateAgent(pid);
  }
}

/**
 * Deletes one FIDO2 discoverable credential from the connected YubiKey by
 * its `credentialId` (as returned by `listFido2ResidentKeys` when `ykman`
 * is available — only those entries can be deleted this way). The caller's
 * own UI is expected to have already confirmed this with the user, since
 * `ykman`'s own confirmation prompt is bypassed (`--force`).
 */
export async function deleteFido2ResidentKey(credentialId: string, promptHandler: AskpassPromptHandler): Promise<void> {
  if (!(await isYkmanAvailable())) {
    throw new Error('Deleting individual resident credentials requires ykman (YubiKey Manager) to be installed.');
  }
  const pin = await promptHandler("Enter your security key's PIN to delete this credential:");
  requirePin(pin);
  // The id comes from the renderer, and the key also holds the user's web passkeys: only ever delete an SSH credential.
  const target = (await listYkmanFidoCredentials(pin)).find((c) => c.credentialId === credentialId);
  if (!target) throw new Error('That credential is no longer on the security key');
  if (!isSshCredential(target)) {
    throw new Error(`Refusing to delete "${target.rpId}": it is not an SSH key (only credentials for "ssh:" are managed here)`);
  }
  await deleteYkmanFidoCredential(credentialId, pin);
}

/** Default directory to write generated FIDO2 keys into, matching OpenSSH's own `~/.ssh` convention. */
export function defaultFido2KeyDir(): string {
  return path.join(os.homedir(), '.ssh');
}
