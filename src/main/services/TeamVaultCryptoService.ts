import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveAgeBinary } from './AgeBinaryResolver';
import { runAgeCommandViaPty, createSecretOutputChannel, readChannelAfterExit, type AgePtyPromptCallbacks } from './AgePtyPinRelay';
import { withPkcs11Lock } from '../smartcard/Pkcs11Lock';
import type { TeamVaultAccessEntry, TeamVaultFile, TeamVaultRecovery } from '../../shared/types/teamVault';

export { TeamVaultWrongPinError, TeamVaultDefaultCredentialsError } from './AgePtyPinRelay';
export type { AgePtyPromptCallbacks } from './AgePtyPinRelay';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VAULT_KEY_LENGTH = 32;
const EXEC_TIMEOUT_MS = 15000;
const MAX_BUFFER = 4 * 1024 * 1024;

export class TeamVaultDecryptionError extends Error {
  constructor(message = 'Wrong Vault Key or corrupted vault payload') {
    super(message);
    this.name = 'TeamVaultDecryptionError';
  }
}

/** The additional authenticated data binding a payload to one specific vault and format — see
 * docs/team-vault-plan.md §2.3 ("AAD=vault_id+format_version"). Without this, a payload cut from
 * one vault file could silently decrypt as if it belonged to a different one. */
function buildAad(vaultId: string, formatVersion: number): Buffer {
  return Buffer.from(`${vaultId}:${formatVersion}`, 'utf8');
}

/** What differs between file format versions as far as authentication goes. A new version is one more row here
 * plus a `canonical*` function below — older rows are never touched, so files written under them keep verifying.
 * The HKDF info strings differ per version (domain separation): a MAC computed for one version can never verify
 * as another, so a bucket-write attacker cannot relabel a file's `formatVersion`. */
const FORMAT_SPECS = {
  1: { macInfo: Buffer.from('team-vault-header-mac-v1', 'utf8'), rotationInfo: Buffer.from('team-vault-rotation-proof-v1', 'utf8') },
  2: { macInfo: Buffer.from('team-vault-header-mac-v2', 'utf8'), rotationInfo: Buffer.from('team-vault-rotation-proof-v2', 'utf8') },
} as const;

type MacFormatVersion = keyof typeof FORMAT_SPECS;

function specFor(formatVersion: number): (typeof FORMAT_SPECS)[MacFormatVersion] {
  const spec = FORMAT_SPECS[formatVersion as MacFormatVersion];
  if (!spec) throw new Error(`Unsupported Team Vault format version ${formatVersion}`);
  return spec;
}

/** A subkey derived from the Vault Key via HKDF, never the raw AES-GCM key itself — simple key
 * separation so the same symmetric secret isn't reused across two different primitives
 * (encryption vs. authentication). */
function deriveHeaderMacKey(vaultKey: Buffer, formatVersion: number = 1): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', vaultKey, Buffer.alloc(0), specFor(formatVersion).macInfo, 32));
}

/** A separate subkey from `deriveHeaderMacKey` (different HKDF info string), so a rotation proof
 * computed under the OLD Vault Key can never be confused with — or substituted for — a header MAC
 * computed under the NEW one, even though both are derived from the same underlying key. */
function deriveRotationProofKey(vaultKey: Buffer, formatVersion: number = 1): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', vaultKey, Buffer.alloc(0), specFor(formatVersion).rotationInfo, 32));
}

export class TeamVaultCanonicalizationError extends Error {
  constructor(label: string) {
    super(
      `${label} contains a reserved control character and can't be safely included in the Team Vault header MAC.`
    );
    this.name = 'TeamVaultCanonicalizationError';
  }
}

// `canonicalAccessHeaderString` joins fields with these three control characters — built from
// character codes, not a regex literal, so they aren't control-character escapes
// eslint-plugin-security's `no-control-regex` (rightly) flags in a `/.../ ` pattern.
function assertNoCanonicalizationDelimiter(value: string, label: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x01 || code === 0x02 || code === 0x03) {
      throw new TeamVaultCanonicalizationError(label);
    }
  }
}

/** A fixed, unambiguous serialization of everything the header MAC covers. Entries are sorted
 * (not kept in array order) so shuffling the array can't produce a different, still-valid tag
 * for the same logical content.
 *
 * `\u0001`/`\u0002`/`\u0003` are the delimiters. Every field is defense-in-depth-checked against
 * containing one via `assertNoCanonicalizationDelimiter` below — not just at the IPC layer that
 * first accepts recipientId/vaultName/vaultDescription (`teamVaultHandlers.ts`'s
 * `requireRecipientId`/`requireVaultName`/`requireVaultDescription`) — because relying solely on
 * callers to remember that discipline is exactly the kind of thing a future new caller forgets.
 * Without this, a value containing a delimiter could shift where this function reads a field
 * boundary: e.g. vaultName `"Foo\u0002Bar"` with no description produces the IDENTICAL canonical
 * string (and therefore MAC) as vaultName `"Foo"` with description `"Bar"` — letting a
 * bucket-write-access-only attacker (no Vault Key) swap which bytes belong to which field while
 * an old, still-valid MAC keeps verifying against the tampered split. Throwing here makes that
 * construction impossible regardless of what calls this function, now or in the future. */
function canonicalAccessHeaderString(
  vaultId: string,
  revision: number,
  vaultName: string,
  accessHeader: TeamVaultAccessEntry[],
  recovery: TeamVaultRecovery,
  vaultDescription = ''
): string {
  assertNoCanonicalizationDelimiter(vaultId, 'vaultId');
  assertNoCanonicalizationDelimiter(vaultName, 'vaultName');
  assertNoCanonicalizationDelimiter(vaultDescription, 'vaultDescription');
  for (const e of accessHeader) {
    assertNoCanonicalizationDelimiter(e.recipientId, 'recipientId');
    assertNoCanonicalizationDelimiter(e.role, 'role');
    assertNoCanonicalizationDelimiter(e.method, 'method');
    assertNoCanonicalizationDelimiter(e.ageRecipient, 'ageRecipient');
    assertNoCanonicalizationDelimiter(e.wrappedVaultKey, 'wrappedVaultKey');
    assertNoCanonicalizationDelimiter(e.addedAt, 'addedAt');
    assertNoCanonicalizationDelimiter(e.addedBy, 'addedBy');
  }
  assertNoCanonicalizationDelimiter(recovery.recipientId, 'recovery.recipientId');
  assertNoCanonicalizationDelimiter(recovery.ageRecipient, 'recovery.ageRecipient');
  assertNoCanonicalizationDelimiter(recovery.wrappedVaultKey, 'recovery.wrappedVaultKey');

  const entryLines = accessHeader
    .map((e) => [e.recipientId, e.role, e.method, e.ageRecipient, e.wrappedVaultKey, e.addedAt, e.addedBy].join('\u0001'))
    .sort();
  const recoveryLine = [recovery.recipientId, recovery.ageRecipient, recovery.wrappedVaultKey].join('\u0001');
  // Backward compatibility: every vault written before `vaultDescription` existed has an
  // `accessHeaderMac` computed over the 3-field header line below, with no description segment
  // at all — not even an empty one. Appending `\u0002${vaultDescription}` unconditionally (even
  // when it's '') would change the canonical bytes, and therefore the MAC, for every one of
  // those vaults on their very next unlock, even though nothing about them actually changed —
  // this broke real installs (TeamVaultHeaderIntegrityError on unlock) the moment this shipped.
  // Only vaults that actually have a description get the 4-field form; the two can never collide
  // with the 3-field form because the delimiter check above has already ruled out a vaultName
  // that could be mistaken for one.
  const headerLine = vaultDescription
    ? `${vaultId}\u0002${revision}\u0002${vaultName}\u0002${vaultDescription}`
    : `${vaultId}\u0002${revision}\u0002${vaultName}`;
  return [headerLine, ...entryLines, recoveryLine].join('\u0003');
}

/**
 * How each field of a `TeamVaultFile` is authenticated in format v2 (a `Record` over every key, so adding a field to the
 * interface without classifying it here is a compile error): `'mac'` fields are covered by the file MAC (and the rotation
 * proof); `'unauthenticated'` ones cannot be, because they ARE the tags. Everything that decides who may open the vault, who
 * wrote it last, what it is called and what it contains is covered, including the payload ciphertext.
 */
export const TEAM_VAULT_FILE_FIELD_COVERAGE: Record<keyof TeamVaultFile, 'mac' | 'unauthenticated'> = {
  formatVersion: 'mac',
  vaultId: 'mac',
  vaultName: 'mac',
  vaultDescription: 'mac',
  revision: 'mac',
  updatedAt: 'mac',
  updatedBy: 'mac',
  accessHeader: 'mac',
  recovery: 'mac',
  encryptedPayload: 'mac',
  accessHeaderMac: 'unauthenticated',
  prevKeyProof: 'unauthenticated',
};

/** What a v2 MAC or rotation proof is computed over — the file minus the two tags. */
export type TeamVaultMacInput = Pick<
  TeamVaultFile,
  | 'formatVersion'
  | 'vaultId'
  | 'vaultName'
  | 'vaultDescription'
  | 'revision'
  | 'updatedAt'
  | 'updatedBy'
  | 'accessHeader'
  | 'recovery'
  | 'encryptedPayload'
>;

/** SHA-256 (base64) of the payload ciphertext exactly as stored: what ties a payload to the header that carries it. */
export function payloadDigest(encryptedPayload: string): string {
  return crypto.createHash('sha256').update(encryptedPayload, 'utf8').digest('base64');
}

/**
 * Canonical string for format v2. Unlike v1 it has no backward-compatibility special cases: the description is always
 * present, and the recovery note, `updatedAt`, `updatedBy`, the format version and the payload digest are all covered.
 * Same delimiter discipline as v1 (`assertNoCanonicalizationDelimiter` on every free-text field).
 */
function canonicalFileStringV2(file: TeamVaultMacInput): string {
  const vaultName = file.vaultName ?? '';
  const vaultDescription = file.vaultDescription ?? '';
  assertNoCanonicalizationDelimiter(file.vaultId, 'vaultId');
  assertNoCanonicalizationDelimiter(vaultName, 'vaultName');
  assertNoCanonicalizationDelimiter(vaultDescription, 'vaultDescription');
  assertNoCanonicalizationDelimiter(file.updatedAt, 'updatedAt');
  assertNoCanonicalizationDelimiter(file.updatedBy, 'updatedBy');
  for (const e of file.accessHeader) {
    assertNoCanonicalizationDelimiter(e.recipientId, 'recipientId');
    assertNoCanonicalizationDelimiter(e.role, 'role');
    assertNoCanonicalizationDelimiter(e.method, 'method');
    assertNoCanonicalizationDelimiter(e.ageRecipient, 'ageRecipient');
    assertNoCanonicalizationDelimiter(e.wrappedVaultKey, 'wrappedVaultKey');
    assertNoCanonicalizationDelimiter(e.addedAt, 'addedAt');
    assertNoCanonicalizationDelimiter(e.addedBy, 'addedBy');
  }
  const recovery = file.recovery;
  assertNoCanonicalizationDelimiter(recovery.recipientId, 'recovery.recipientId');
  assertNoCanonicalizationDelimiter(recovery.ageRecipient, 'recovery.ageRecipient');
  assertNoCanonicalizationDelimiter(recovery.wrappedVaultKey, 'recovery.wrappedVaultKey');
  assertNoCanonicalizationDelimiter(recovery.note ?? '', 'recovery.note');

  const headerLine = [file.formatVersion, file.vaultId, file.revision, file.updatedAt, file.updatedBy, vaultName, vaultDescription].join('\u0002');
  const entryLines = file.accessHeader
    .map((e) => [e.recipientId, e.role, e.method, e.ageRecipient, e.wrappedVaultKey, e.addedAt, e.addedBy].join('\u0001'))
    .sort();
  const recoveryLine = [recovery.recipientId, recovery.ageRecipient, recovery.wrappedVaultKey, recovery.note ?? ''].join('\u0001');
  const payloadLine = ['payload', payloadDigest(file.encryptedPayload)].join('\u0001');
  return [headerLine, ...entryLines, recoveryLine, payloadLine].join('\u0003');
}

/**
 * Rejects a value that would be interpreted as another CLI flag rather than the positional
 * argument it's meant to be (classic argument-injection: a value like `-o/etc/passwd` or
 * `--output=...` landing where a recipient string or file path was expected). `execFile` already
 * avoids shell interpolation, but it does nothing to stop the *binary itself* from parsing an
 * attacker-influenced value as one of its own flags — this is the defense for that, applied at
 * the actual sink regardless of what the IPC layer already checked. */
function assertNotFlagLike(value: string, label: string): void {
  if (!value || value.startsWith('-')) {
    throw new Error(`Invalid ${label}`);
  }
}

/** Like String.trim(), but only for space, tab, CR and LF: not a BOM, NBSP, U+2028 or the like. */
function trimAsciiWhitespace(text: string): string {
  const isBlank = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
  let start = 0;
  let end = text.length;
  while (start < end && isBlank(text[start])) start += 1;
  while (end > start && isBlank(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

const AGE_ARMOR_BEGIN = '-----BEGIN AGE ENCRYPTED FILE-----';
const AGE_ARMOR_END = '-----END AGE ENCRYPTED FILE-----';
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The ciphertext is typed into a pty (on POSIX), where `age` and `age-plugin-yubikey` read from the same
 * terminal: any byte other than the armor itself — a control character, a second line of text, a PIN
 * guess after the footer — would be treated as terminal input. It comes from an invite the user pasted or
 * from a vault file on a shared bucket, and the access header's MAC can only be checked after this very
 * decryption has produced the Vault Key, so it has to be validated here, at the sink. Surrounding
 * whitespace (a pasted blank line, a trailing newline or two) is dropped; what remains must be exactly one
 * armored file: the header, at least one base64 line, the footer. Returns the text to send, which is the
 * text that was validated.
 */
export function normalizeAsciiArmoredAge(ciphertext: string): string {
  const lines = typeof ciphertext === 'string' ? trimAsciiWhitespace(ciphertext).split(/\r?\n/) : [];
  const valid =
    lines.length >= 3 &&
    lines[0] === AGE_ARMOR_BEGIN &&
    lines[lines.length - 1] === AGE_ARMOR_END &&
    lines.slice(1, -1).every((line) => BASE64_LINE.test(line));
  if (!valid) throw new Error('Not a valid ASCII-armored age ciphertext');
  return `${lines.join('\n')}\n`;
}

/**
 * Crypto primitives for the Team Vault (docs/team-vault-plan.md), a separate trust model from
 * `SyncCryptoService`: instead of one password shared by everyone, a random "Vault Key" encrypts
 * the payload, and that Vault Key is wrapped individually per recipient via `age` +
 * `age-plugin-yubikey` against each member's PIV hardware key (§2.1-2.2). The Vault Key itself is
 * never derived from a password and never touches disk outside this process' memory — callers are
 * responsible for discarding it on lock/quit, exactly as `SyncCryptoService.lock()` does for its
 * own keys today.
 */
export class TeamVaultCryptoService {
  /** A fresh, random 256-bit Vault Key. Never persisted directly — only its per-recipient
   * `age`-wrapped form (see `wrapVaultKeyForRecipient`) is written to the vault file. */
  generateVaultKey(): Buffer {
    return crypto.randomBytes(VAULT_KEY_LENGTH);
  }

  /** AES-256-GCM-encrypts `plaintext` under `vaultKey`, bound to `vaultId`/`formatVersion` via
   * AAD. Returns base64 of `[iv(12)][authTag(16)][ciphertext]`, matching the vault file's
   * `encrypted_payload` field (§2.3). */
  encryptPayload(vaultKey: Buffer, vaultId: string, formatVersion: number, plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey, iv);
    cipher.setAAD(buildAad(vaultId, formatVersion));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
  }

  /** Reverses `encryptPayload`. Throws `TeamVaultDecryptionError` on a wrong Vault Key,
   * mismatched `vaultId`/`formatVersion`, or a corrupted/tampered payload — AES-GCM's auth tag
   * check doubles as that verification, same as `SyncCryptoService.decrypt()`. */
  decryptPayload(vaultKey: Buffer, vaultId: string, formatVersion: number, encryptedPayload: string): string {
    const data = Buffer.from(encryptedPayload, 'base64');
    if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new TeamVaultDecryptionError('Encrypted payload is truncated or corrupt');
    }
    const iv = data.subarray(0, IV_LENGTH);
    const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey, iv, { authTagLength: AUTH_TAG_LENGTH });
      decipher.setAAD(buildAad(vaultId, formatVersion));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new TeamVaultDecryptionError();
    }
  }

  /**
   * Shared mechanics behind `wrapVaultKeyForRecipient` and `encryptForRecipient` — a pure
   * public-key `age -r <ageRecipient> -a` operation (§4.3: "admin needs only the member's public
   * certificate"), so no PIV card or PIN is involved on either side, regardless of what `input`
   * actually is (a 32-byte Vault Key, or an arbitrary plaintext string). Returns the raw armored
   * ciphertext bytes; callers decide whether/how to decode them.
   *
   * For an `age1yubikey1...` recipient, `age` still execs `age-plugin-yubikey` to parse/validate
   * the recipient stanza (no hardware/PIN touched for a pure wrap) — it needs the same
   * PATH-prepending `decryptForIdentity` already gets, found missing when exercising this
   * end-to-end for the first time against a real yubikey recipient (see docs/team-vault-plan.md).
   */
  private async encryptToRecipient(input: Buffer, ageRecipient: string): Promise<Buffer> {
    assertNotFlagLike(ageRecipient, 'age recipient');
    const pluginPath = resolveAgeBinary('age-plugin-yubikey');
    return runAgeCommand(resolveAgeBinary('age'), ['-r', ageRecipient, '-a'], input, pluginPathEnv(pluginPath));
  }

  /** Wraps `vaultKey` for one recipient — see `encryptToRecipient` for the shared mechanics.
   * Returns the armored ciphertext to store as that recipient's `wrapped_vault_key` (§2.3). */
  async wrapVaultKeyForRecipient(vaultKey: Buffer, ageRecipient: string): Promise<string> {
    return (await this.encryptToRecipient(vaultKey, ageRecipient)).toString('utf8');
  }

  /**
   * Encrypts arbitrary text for one recipient — see `encryptToRecipient` for the shared
   * mechanics, just generalized to any plaintext rather than a 32-byte Vault Key. Used by
   * `TeamVaultService.buildInvite` to hand a new member their vault's S3 target without them
   * typing it in by hand (docs/team-vault-plan.md join-flow simplification). Returns the armored
   * ciphertext.
   */
  async encryptForRecipient(plaintext: string, ageRecipient: string): Promise<string> {
    return (await this.encryptToRecipient(Buffer.from(plaintext, 'utf8'), ageRecipient)).toString('utf8');
  }

  /**
   * Shared mechanics behind `unwrapVaultKey` and `decryptWithIdentity` — `age -d -i
   * <identityFilePath>` via a pty (hardware-verified, docs/team-vault-plan.md
   * "Hårdvaruverifiering": `age-plugin-yubikey` needs a real controlling terminal to prompt for
   * PIN/touch — plain `execFile`/pipes fails with "IO error: not a terminal"). `identityFilePath`
   * holds a public `AGE-PLUGIN-YUBIKEY-...` identity stanza (a reference to the card's slot, not
   * a secret) — `age` resolves it through the `age-plugin-yubikey` plugin binary, which talks to
   * the physical PIV token. `callbacks` collects the PIN from the UI and surfaces the touch
   * prompt — see `AgePtyPinRelay`.
   *
   * The decrypted result must never flow through the pty's own text channel (UTF-8-decoded and
   * CRLF-normalized — see docs/team-vault-plan.md; `age` also refuses outright to write binary to
   * a terminal) regardless of whether the caller's own result happens to be text (the invite's
   * JSON) or binary (the Vault Key) — routing it through the pty's text channel would otherwise
   * mix the decrypted content with terminal echo of the piped-in ciphertext and any PIN-prompt
   * noise either way. Instead `-o <path>` redirects it to a FIFO (a named pipe on Windows) — a kernel
   * pipe, never written to disk — read back via `createSecretOutputChannel`. Verified byte-exact against real hardware.
   */
  private async decryptWithIdentityFile(
    armoredCiphertext: string,
    identityFilePath: string,
    callbacks: AgePtyPromptCallbacks
  ): Promise<Buffer> {
    assertNotFlagLike(identityFilePath, 'identity file path');
    const armored = normalizeAsciiArmoredAge(armoredCiphertext);
    const agePath = resolveAgeBinary('age');
    const pluginPath = resolveAgeBinary('age-plugin-yubikey');
    const channel = await createSecretOutputChannel(os.tmpdir());
    let ciphertextFile: string | undefined;
    try {
      const args = ['-d', '-i', identityFilePath, '-o', channel.path];
      let stdin: string | undefined = armored;
      if (process.platform === 'win32') {
        // A ConPTY has no Ctrl-D end-of-input, so the ciphertext can't be piped in through it.
        // It isn't a secret (the same text sits in the vault file on disk), so hand it over as a
        // file argument instead.
        ciphertextFile = path.join(os.tmpdir(), `${crypto.randomUUID()}.age`);
        await fs.writeFile(ciphertextFile, armored, { mode: 0o600 });
        args.push(ciphertextFile);
        stdin = undefined;
      }
      // `age-plugin-yubikey` talks PIV/PC-SC directly to the physical card — same class of
      // "broadly unreliable under concurrent access" issue `Pkcs11Lock`'s doc comment describes
      // for vendor PKCS#11 modules, confirmed in practice: unlocking two different Team Vaults at
      // once (e.g. "Unlock all" with 2+ locked teams sharing a card) raced two independent
      // age-plugin-yubikey processes against the same USB token — one touch could only satisfy
      // one of them, and the other failed silently. Serializing here, app-wide, is the same fix
      // already applied to every other native-smartcard call this app makes.
      await withPkcs11Lock(() =>
        runAgeCommandViaPty(
          agePath,
          args,
          // `age` discovers `age-plugin-yubikey` by name on PATH; prepend its resolved directory
          // so a bundled (packaged-app) or dev-fetched copy is found even when not installed
          // system-wide.
          pluginPathEnv(pluginPath),
          callbacks,
          undefined,
          stdin
        )
      );
      return await readChannelAfterExit(channel);
    } finally {
      await channel.dispose();
      if (ciphertextFile) await fs.rm(ciphertextFile, { force: true });
    }
  }

  /** Unwraps a `wrapped_vault_key` back into the raw Vault Key bytes — see
   * `decryptWithIdentityFile` for the shared mechanics. Kept as a raw `Buffer`, never
   * `.toString()`'d, since the Vault Key is a binary secret, not text. */
  async unwrapVaultKey(
    wrappedVaultKey: string,
    identityFilePath: string,
    callbacks: AgePtyPromptCallbacks
  ): Promise<Buffer> {
    return this.decryptWithIdentityFile(wrappedVaultKey, identityFilePath, callbacks);
  }

  /**
   * Generates a fresh `age-plugin-yubikey` recipient from the operator's own PIV card
   * (`age-plugin-yubikey --generate`) and persists the resulting identity stanza to a file under
   * `identityOutDir` for later use by `unwrapVaultKey`. Returns the public `age1yubikey1...`
   * recipient string — safe to hand to whoever is adding this person to the vault (§4.3: "admin
   * needs only the member's public certificate").
   *
   * Hardware-verified (docs/team-vault-plan.md "Hårdvaruverifiering"): runs through the same
   * `runAgeCommandViaPty` as `unwrapVaultKey` — its output is pure text (the identity stanza), so
   * it needs no FIFO.
   */
  async enrollOwnPivRecipient(
    identityOutDir: string,
    callbacks: AgePtyPromptCallbacks
  ): Promise<{ recipient: string; identityFilePath: string }> {
    // Same app-wide serialization as `decryptWithIdentityFile` — this also talks PIV/PC-SC
    // directly to the physical card.
    const text = await withPkcs11Lock(() =>
      runAgeCommandViaPty(resolveAgeBinary('age-plugin-yubikey'), ['--generate'], process.env, callbacks)
    );
    const recipientMatch = text.match(/age1yubikey1\S+/);
    if (!recipientMatch) {
      throw new Error('age-plugin-yubikey --generate did not produce a recipient string');
    }

    await fs.mkdir(identityOutDir, { recursive: true });
    const identityFilePath = path.join(identityOutDir, `${crypto.randomUUID()}.txt`);
    await fs.writeFile(identityFilePath, extractStanza(text, PIV_IDENTITY_PATTERN), { mode: 0o600 });

    return { recipient: recipientMatch[0], identityFilePath };
  }

  /**
   * Generates a fresh software age identity (via `age-keygen`) for the vault's recovery key
   * (§4.1): an ordinary age keypair the admin prints and locks away, deliberately not tied to any
   * hardware so it still works if every PIV card is lost. Returns the plaintext identity (to show
   * the admin exactly once — the caller must never persist it) and its public recipient string.
   */
  async generateRecoveryIdentity(): Promise<{ identity: string; recipient: string }> {
    const stdout = await runAgeCommand(resolveAgeBinary('age-keygen'), [], Buffer.alloc(0));
    const identity = stdout.toString('utf8');
    const recipientMatch = identity.match(/#\s*public key:\s*(age1\S+)/i);
    if (!recipientMatch) {
      throw new Error('age-keygen did not produce a recognizable public key comment');
    }
    return { identity, recipient: recipientMatch[1] };
  }

  /**
   * Unwraps a `wrapped_vault_key` with a user-pasted recovery identity (the text
   * `generateRecoveryIdentity` showed them once at vault creation) — see
   * `TeamVaultService.unlockWithRecoveryText`. The recovery identity is a private key, so per
   * CLAUDE.md it must never be written to disk: it goes to `age -d -i -` on stdin and the Vault
   * Key comes back on stdout. A software identity never prompts for a PIN or touch, so unlike
   * `unwrapVaultKey` this needs neither a pty nor a FIFO/pipe — which also makes it work the
   * same on Windows. The ciphertext isn't secret (it is stored in the vault file), so it is
   * passed as a temp file, stdin being taken by the identity.
   *
   * Tolerates surrounding noise (chat/email quoting, extra blank lines) via `extractStanza`.
   * Throws if no recognizable `AGE-SECRET-KEY-1...` line is found.
   */
  async unwrapVaultKeyWithRecoveryIdentity(wrappedVaultKey: string, identityText: string): Promise<Buffer> {
    if (!RECOVERY_IDENTITY_PATTERN.test(identityText)) {
      throw new Error('This does not look like a Team Vault recovery key (no AGE-SECRET-KEY-1... line found)');
    }
    const stanza = extractStanza(identityText, RECOVERY_IDENTITY_PATTERN);
    const ciphertextFile = path.join(os.tmpdir(), `${crypto.randomUUID()}.age`);
    await fs.writeFile(ciphertextFile, wrappedVaultKey, { mode: 0o600 });
    try {
      return await runAgeCommand(resolveAgeBinary('age'), ['-d', '-i', '-', ciphertextFile], Buffer.from(stanza, 'utf8'));
    } finally {
      await fs.rm(ciphertextFile, { force: true });
    }
  }

  /**
   * HMAC-SHA256 over the access header (`vaultId` + `revision` + `vaultName` + every entry + the
   * recovery entry), keyed by a subkey derived from the Vault Key. Lets
   * `TeamVaultService.pullFromRemote` detect tampering with the header itself — a substituted or
   * wholly new entry, a changed role, a renamed vault, anything — without depending on which
   * specific `revision` delta the tamperer claims: unlike a decrypt-based heuristic (which only
   * works for an exact, narrow revision gap, and is trivially dodged by choosing a different
   * one), computing a valid tag requires the real Vault Key, regardless of what revision number
   * is attached to it. Mere S3 write access doesn't provide that key.
   */
  computeAccessHeaderMac(
    vaultKey: Buffer,
    vaultId: string,
    revision: number,
    vaultName: string,
    accessHeader: TeamVaultAccessEntry[],
    recovery: TeamVaultRecovery,
    vaultDescription = ''
  ): string {
    const macKey = deriveHeaderMacKey(vaultKey);
    const canonical = canonicalAccessHeaderString(vaultId, revision, vaultName, accessHeader, recovery, vaultDescription);
    return crypto.createHmac('sha256', macKey).update(canonical, 'utf8').digest('base64');
  }

  /**
   * HMAC-SHA256 over the NEW access header (same canonical fields as `computeAccessHeaderMac`),
   * keyed by a subkey derived from the OLD Vault Key — the one being rotated away from, e.g. by
   * `removeMember`. Lets `TeamVaultService.pullFromRemote` tell a real rotation apart from a
   * bucket-write-access-only attacker's own fresh key when the access header shrinks (see
   * `TeamVaultRotationProofError`'s doc comment): only whoever actually held the real old Vault
   * Key can produce a matching tag, regardless of which public recipients the new key was wrapped
   * for. `oldVaultKey` must be the Vault Key in effect immediately before this rotation — a proof
   * computed against a key from further back in history won't verify, by design (see that error's
   * note on multi-step catch-up).
   */
  computeRotationProof(
    oldVaultKey: Buffer,
    newVaultId: string,
    newRevision: number,
    newVaultName: string,
    newAccessHeader: TeamVaultAccessEntry[],
    newRecovery: TeamVaultRecovery,
    newVaultDescription = ''
  ): string {
    const proofKey = deriveRotationProofKey(oldVaultKey);
    const canonical = canonicalAccessHeaderString(
      newVaultId,
      newRevision,
      newVaultName,
      newAccessHeader,
      newRecovery,
      newVaultDescription
    );
    return crypto.createHmac('sha256', proofKey).update(canonical, 'utf8').digest('base64');
  }

  /**
   * The file MAC for whichever format the file is in, so callers never pick a canonicalization themselves. v1 is the
   * original header-only MAC (`computeAccessHeaderMac`, unchanged); v2 also covers the payload ciphertext, `updatedAt`,
   * `updatedBy`, the format version and the recovery note (`canonicalFileStringV2`). A payload cut from an older revision
   * and placed under a current header therefore no longer verifies.
   */
  computeFileMac(vaultKey: Buffer, file: TeamVaultMacInput): string {
    if (file.formatVersion === 1) {
      return this.computeAccessHeaderMac(
        vaultKey,
        file.vaultId,
        file.revision,
        file.vaultName ?? '',
        file.accessHeader,
        file.recovery,
        file.vaultDescription ?? ''
      );
    }
    const macKey = deriveHeaderMacKey(vaultKey, file.formatVersion);
    return crypto.createHmac('sha256', macKey).update(canonicalFileStringV2(file), 'utf8').digest('base64');
  }

  /**
   * The rotation proof for the NEW file of a `removeMember` rotation, keyed from the OLD Vault Key, for whichever format
   * that new file is in (see `computeRotationProof` for what it proves). v2 covers the same fields as the v2 file MAC, so it
   * also vouches for the re-encrypted payload.
   */
  computeFileRotationProof(oldVaultKey: Buffer, newFile: TeamVaultMacInput): string {
    if (newFile.formatVersion === 1) {
      return this.computeRotationProof(
        oldVaultKey,
        newFile.vaultId,
        newFile.revision,
        newFile.vaultName ?? '',
        newFile.accessHeader,
        newFile.recovery,
        newFile.vaultDescription ?? ''
      );
    }
    const proofKey = deriveRotationProofKey(oldVaultKey, newFile.formatVersion);
    return crypto.createHmac('sha256', proofKey).update(canonicalFileStringV2(newFile), 'utf8').digest('base64');
  }

  /** Decrypts an `encryptForRecipient`-produced blob with the identity at `identityFilePath` —
   * see `decryptWithIdentityFile` for the shared mechanics. Returns text (the invite's small JSON
   * object), not a raw secret buffer, since unlike `unwrapVaultKey`'s result this one is meant to
   * be read as a string. */
  async decryptWithIdentity(
    armoredCiphertext: string,
    identityFilePath: string,
    callbacks: AgePtyPromptCallbacks
  ): Promise<string> {
    return (await this.decryptWithIdentityFile(armoredCiphertext, identityFilePath, callbacks)).toString('utf8');
  }
}

const PIV_IDENTITY_PATTERN = /AGE-PLUGIN-YUBIKEY-\S+/;
const RECOVERY_IDENTITY_PATTERN = /AGE-SECRET-KEY-1\S+/i;

/** Extracts just the real identity stanza (the `#`-comment block plus the actual secret-identity
 * line matched by `identityPattern`) from a larger, possibly noisy block of text — either the pty
 * transcript `runAgeCommandViaPty` captures (interactive status/prompt lines, the echoed PIN
 * prompt with cursor-redraw escape codes, a touch-prompt line, all preceding the real stanza — see
 * `enrollOwnPivRecipient`) or arbitrary text a user pasted back in (surrounding email/chat quoting,
 * extra blank lines — see `TeamVaultService.unlockWithRecoveryText`). Either way, `age -d -i
 * <file>` rejects anything that isn't exactly the stanza itself ("unknown identity type" — found
 * via manual end-to-end testing, see docs/team-vault-plan.md). Walks backward from the identity
 * line through contiguous `#` comment lines (skipping blank lines) to reconstruct exactly the
 * stanza the originating `age`-family command would have printed to a plain pipe. */
function extractStanza(text: string, identityPattern: RegExp): string {
  const identityMatch = text.match(identityPattern);
  if (!identityMatch || identityMatch.index === undefined) return text;

  const precedingLines = text.slice(0, identityMatch.index).split(/\r\n|\r|\n/);
  const commentLines: string[] = [];
  for (let i = precedingLines.length - 1; i >= 0; i--) {
    const line = precedingLines[i].trim();
    if (line === '') continue;
    if (!line.startsWith('#')) break;
    commentLines.unshift(line);
  }
  return [...commentLines, identityMatch[0]].join('\n') + '\n';
}

function pluginPathEnv(pluginPath: string): NodeJS.ProcessEnv {
  const pluginDir = pluginPath.includes('/') || pluginPath.includes('\\') ? dirnameOf(pluginPath) : undefined;
  if (!pluginDir) return process.env;
  const pathSep = process.platform === 'win32' ? ';' : ':';
  // Windows env names are case-insensitive but a plain object isn't: process.env spreads as
  // `Path`, and adding a second `PATH` key would leave the child with two variants.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...process.env, [pathKey]: `${pluginDir}${pathSep}${process.env[pathKey] ?? ''}` };
}

function dirnameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? '' : p.slice(0, idx);
}

/** Runs an `age`-family binary, feeding `input` on stdin and collecting stdout as a Buffer.
 * Mirrors the defensive timeout/maxBuffer style already used for `certWorker.cjs` invocations. */
function runAgeCommand(
  binary: string,
  args: string[],
  input: Buffer,
  env: NodeJS.ProcessEnv = process.env
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'buffer', env },
      (err, stdout, stderr) => {
        if (err) {
          // A bare ENOENT (no stdout/stderr at all) means the OS never found the binary to
          // launch it — surfacing the raw "spawn age ENOENT" is unhelpful; name what's actually
          // missing and point at how it's supposed to get there (CI-bundled in a packaged build,
          // or a local install in dev — see docs/team-vault-plan.md, phase 1).
          if ((err as any).code === 'ENOENT') {
            reject(
              new Error(
                `"${binary}" was not found. In a packaged build this is bundled automatically; in development, install it locally or run a build that fetches it (see docs/team-vault-plan.md, phase 1).`
              )
            );
            return;
          }
          const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
          reject(new Error(stderrText.trim() || err.message));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      }
    );
    child.stdin?.end(input);
  });
}
