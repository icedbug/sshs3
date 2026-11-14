import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface WebUserRecord {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
  lastLoginAt?: number;
}

export interface WebUserPublic {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  createdAt: number;
  lastLoginAt?: number;
  sshPublicKey?: string;
  sshPrivateKeyPath?: string;
}

export interface WebInviteRecord {
  token: string;
  role: 'admin' | 'member';
  note?: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
}

interface WebSessionRecord {
  /** SHA-256 of the session token. The token itself is only ever held by the browser. */
  hash: string;
  /** Left by an older version that stored the token itself: turned into `hash` when the file is read. */
  token?: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

const sessionHash = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

interface StoredAuthData {
  version: 1;
  users: WebUserRecord[];
  invites: WebInviteRecord[];
  sessions: WebSessionRecord[];
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashPassword(password: string, saltHex: string): string {
  return crypto
    .scryptSync(password, Buffer.from(saltHex, 'hex'), 64, {
      N: 16384,
      r: 8,
      p: 1,
    })
    .toString('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function encodeSshString(buf: Buffer | string): Buffer {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

/**
 * Pure Node.js generator for OpenSSH Ed25519 keypairs (id_ed25519 + id_ed25519.pub).
 * Works everywhere without requiring external ssh-keygen binaries.
 */
function generateOpenSshEd25519KeyPair(comment: string): {
  privateKeyPem: string;
  publicKeyLine: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwkPriv = privateKey.export({ format: 'jwk' });
  const jwkPub = publicKey.export({ format: 'jwk' });
  const rawPub = Buffer.from(jwkPub.x!, 'base64url'); // 32 bytes
  const rawSeed = Buffer.from(jwkPriv.d!, 'base64url'); // 32 bytes
  const rawSecret64 = Buffer.concat([rawSeed, rawPub]); // 64 bytes

  const keyType = 'ssh-ed25519';
  const pubBlob = Buffer.concat([
    encodeSshString(keyType),
    encodeSshString(rawPub),
  ]);
  const publicKeyLine = `${keyType} ${pubBlob.toString('base64')} ${comment}`;

  const checkInt = crypto.randomBytes(4).readUInt32BE(0);
  const checkBuf = Buffer.alloc(8);
  checkBuf.writeUInt32BE(checkInt, 0);
  checkBuf.writeUInt32BE(checkInt, 4);

  const privateSectionUnpadded = Buffer.concat([
    checkBuf,
    encodeSshString(keyType),
    encodeSshString(rawPub),
    encodeSshString(rawSecret64),
    encodeSshString(comment),
  ]);

  const blockSize = 8;
  const padLen =
    (blockSize - (privateSectionUnpadded.length % blockSize)) % blockSize;
  const padding = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) {
    padding[i] = (i + 1) & 0xff;
  }
  const privateSection = Buffer.concat([privateSectionUnpadded, padding]);

  const magic = Buffer.from('openssh-key-v1\0', 'ascii');
  const numKeys = Buffer.alloc(4);
  numKeys.writeUInt32BE(1, 0);

  const fullBlob = Buffer.concat([
    magic,
    encodeSshString('none'),
    encodeSshString('none'),
    encodeSshString(Buffer.alloc(0)),
    numKeys,
    encodeSshString(pubBlob),
    encodeSshString(privateSection),
  ]);

  const b64 = fullBlob.toString('base64');
  const lines = b64.match(/.{1,70}/g) ?? [b64];
  const privateKeyPem = [
    '-----BEGIN OPENSSH PRIVATE KEY-----', // pragma: allowlist secret
    ...lines,
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n');

  return { privateKeyPem, publicKeyLine };
}

/**
 * Makes a private key file readable by the account sshs3 runs as and by nobody else, the way
 * ssh.exe and ssh-keygen.exe require on Windows. There a file mode sets no access list: the file
 * inherits its folder's, which usually lets other accounts read it, and OpenSSH then refuses the key
 * ("UNPROTECTED PRIVATE KEY FILE"). Elsewhere the mode the file was written with is the restriction.
 * Returns whether the file is restricted now.
 */
export function restrictPrivateKeyFile(
  file: string,
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => unknown = (command, args) =>
    execFileSync(command, args, { timeout: 10_000, stdio: 'ignore', windowsHide: true }),
): boolean {
  if (platform !== 'win32') return true;
  let user: string;
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USERNAME ?? '';
  }
  if (!user) return false;
  const domain = process.env.USERDOMAIN;
  // The account with its domain (or computer) name first: a bare name can be taken for another
  // account of the same name. A service account has no such name, so the bare name is tried too.
  for (const account of domain ? [`${domain}\\${user}`, user] : [user]) {
    try {
      run('icacls', [file, '/inheritance:r', '/grant:r', `${account}:F`]);
      return true;
    } catch {
      // try the next way of naming the account
    }
  }
  return false;
}

export class WebAuthService {
  private readonly authFilePath: string;
  private data: StoredAuthData = {
    version: 1,
    users: [],
    invites: [],
    sessions: [],
  };
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private loginAttempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly baseDataDir: string) {
    this.authFilePath = path.join(baseDataDir, 'web-users.json');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fsp.mkdir(this.baseDataDir, { recursive: true, mode: 0o700 });
    try {
      const raw = (await fsp.readFile(this.authFilePath, 'utf8'))
        .replace(/^\uFEFF/, '')
        .trim();
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredAuthData>;
        this.data = {
          version: 1,
          users: Array.isArray(parsed.users) ? parsed.users : [],
          invites: Array.isArray(parsed.invites) ? parsed.invites : [],
          // A session stored by its token (an older version) keeps working: only its hash is kept from now on.
          sessions: (Array.isArray(parsed.sessions) ? parsed.sessions : []).map(({ token, ...rest }) => ({
            ...rest,
            hash: rest.hash || (token ? sessionHash(token) : ''),
          })),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }

    // Optional env-based initial admin bootstrap for automated VM deployments
    if (
      this.data.users.length === 0 &&
      process.env.SSHS3_ADMIN_USER?.trim() &&
      process.env.SSHS3_ADMIN_PASSWORD?.trim()
    ) {
      await this.createUserInternal({
        username: process.env.SSHS3_ADMIN_USER.trim(),
        password: process.env.SSHS3_ADMIN_PASSWORD,
        displayName:
          process.env.SSHS3_ADMIN_DISPLAY_NAME?.trim() ||
          process.env.SSHS3_ADMIN_USER.trim(),
        role: 'admin',
      });
    }

    for (const user of this.data.users) {
      await this.ensureUserSshKey(user.id, user.username);
    }

    this.initialized = true;
  }

  private save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2);
    const write = async (): Promise<void> => {
      await fsp.mkdir(this.baseDataDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.authFilePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fsp.writeFile(tmp, content, {
        mode: 0o600,
      });
      await fsp.rename(tmp, this.authFilePath);
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }

  hasAnyUsers(): boolean {
    return this.data.users.length > 0;
  }

  /** How many accounts this server has. */
  userCount(): number {
    return this.data.users.length;
  }

  getUserDataDir(userId: string): string {
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.baseDataDir, 'users', safeId);
  }

  /** Private key files whose access was restricted by this process (see restrictPrivateKeyFile). */
  private readonly restrictedKeys = new Set<string>();

  getUserSshDir(userId: string): string {
    return path.join(this.getUserDataDir(userId), '.ssh');
  }

  getUserPrivateKeyPath(userId: string): string {
    return path.join(this.getUserSshDir(userId), 'id_ed25519');
  }

  getUserPublicKeyPath(userId: string): string {
    return path.join(this.getUserSshDir(userId), 'id_ed25519.pub');
  }

  async ensureUserSshKey(
    userId: string,
    username: string,
    forceRotate = false,
  ): Promise<{ privateKeyPath: string; publicKey: string }> {
    const sshDir = this.getUserSshDir(userId);
    const privPath = this.getUserPrivateKeyPath(userId);
    const pubPath = this.getUserPublicKeyPath(userId);
    await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });

    if (!forceRotate && fs.existsSync(privPath) && fs.existsSync(pubPath)) {
      // A key written before sshs3 restricted it (on Windows) is put right once, when it is next asked for.
      if (!this.restrictedKeys.has(privPath) && restrictPrivateKeyFile(privPath)) this.restrictedKeys.add(privPath);
      const pub = (await fsp.readFile(pubPath, 'utf8')).trim();
      return { privateKeyPath: privPath, publicKey: pub };
    }

    const comment = `${username}@sshs3-web`;
    const { privateKeyPem, publicKeyLine } =
      generateOpenSshEd25519KeyPair(comment);
    await fsp.writeFile(privPath, privateKeyPem, { mode: 0o600 });
    if (restrictPrivateKeyFile(privPath)) this.restrictedKeys.add(privPath);
    await fsp.writeFile(pubPath, `${publicKeyLine}\n`, { mode: 0o644 });

    const pub = (await fsp.readFile(pubPath, 'utf8')).trim();
    return { privateKeyPath: privPath, publicKey: pub };
  }

  async importUserSshKey(
    userId: string,
    privateKeyPem: string,
    publicKeyLine?: string,
  ): Promise<{ privateKeyPath: string; publicKey: string }> {
    const trimmedPriv = privateKeyPem.trim();
    if (!trimmedPriv.includes('PRIVATE KEY')) {
      throw new Error('Not a valid private SSH key (OpenSSH or PEM format is needed)');
    }
    const sshDir = this.getUserSshDir(userId);
    const privPath = this.getUserPrivateKeyPath(userId);
    const pubPath = this.getUserPublicKeyPath(userId);
    await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });

    // The public key is worked out from the pasted key in a file of its own
    // first. Only a key that it could be worked out from replaces the one
    // that is there: a key with a passphrase, or a damaged paste, changes nothing.
    let derivedPub = publicKeyLine?.trim() || '';
    if (!derivedPub) {
      const trial = `${privPath}.import-${crypto.randomBytes(6).toString('hex')}`;
      try {
        await fsp.writeFile(trial, `${trimmedPriv}\n`, { mode: 0o600 });
        restrictPrivateKeyFile(trial);
        derivedPub = execFileSync('ssh-keygen', ['-y', '-P', '', '-f', trial], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        derivedPub = '';
      } finally {
        await fsp.rm(trial, { force: true });
      }
      if (!/^(ssh-|ecdsa-|sk-)\S+ \S+/.test(derivedPub)) {
        throw new Error(
          'The public key could not be worked out from this key. Is it protected by a passphrase? Paste a key without one, or give the public key too.',
        );
      }
    }
    await fsp.writeFile(privPath, `${trimmedPriv}\n`, { mode: 0o600 });
    if (restrictPrivateKeyFile(privPath)) this.restrictedKeys.add(privPath);
    await fsp.writeFile(pubPath, `${derivedPub}\n`, { mode: 0o644 });
    return { privateKeyPath: privPath, publicKey: derivedPub };
  }

  async toPublicUser(user: WebUserRecord): Promise<WebUserPublic> {
    const { privateKeyPath, publicKey } = await this.ensureUserSshKey(
      user.id,
      user.username,
    );
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      sshPublicKey: publicKey,
      sshPrivateKeyPath: privateKeyPath,
    };
  }

  private normalizeUsername(username: string): string {
    const clean = username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,40}$/.test(clean)) {
      throw new Error(
        'The user name must be 2–40 characters (a-z, 0-9, dot, hyphen or underscore)',
      );
    }
    return clean;
  }

  private validatePassword(password: string): void {
    if (typeof password !== 'string' || password.length < 6) { // pragma: allowlist secret
      throw new Error('The password must be at least 6 characters');
    }
  }

  private async createUserInternal(input: {
    username: string;
    password: string;
    displayName?: string;
    role: 'admin' | 'member';
  }): Promise<WebUserRecord> {
    const username = this.normalizeUsername(input.username);
    this.validatePassword(input.password);
    if (this.data.users.some((u) => u.username === username)) {
      throw new Error(`The user name "${username}" is taken`);
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(input.password, salt);
    const record: WebUserRecord = {
      id: `usr_${crypto.randomBytes(8).toString('hex')}`,
      username,
      displayName: input.displayName?.trim() || username,
      role: input.role,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: Date.now(),
    };
    this.data.users.push(record);
    await this.ensureUserSshKey(record.id, record.username);
    await this.save();
    return record;
  }

  async setupInitialAdmin(input: {
    username: string;
    password: string;
    displayName?: string;
  }): Promise<{ user: WebUserPublic; sessionToken: string }> {
    if (this.data.users.length > 0) {
      throw new Error('An administrator is already set up on this server');
    }
    const user = await this.createUserInternal({
      username: input.username,
      password: input.password,
      displayName: input.displayName,
      role: 'admin',
    });
    const sessionToken = await this.createSession(user.id);
    return {
      user: await this.toPublicUser(user),
      sessionToken,
    };
  }

  async login(
    usernameInput: string,
    passwordInput: string,
    clientIp = 'local',
  ): Promise<{ user: WebUserPublic; sessionToken: string }> {
    const now = Date.now();
    const username = usernameInput.trim().toLowerCase();
    // Per caller and per account: behind a proxy every caller is the proxy, and a guesser who spreads
    // over many addresses still meets the account's own limit.
    const accountKey = `account:${username}`;
    for (const key of [clientIp, accountKey]) {
      const rate = this.loginAttempts.get(key);
      if (rate && rate.resetAt > now && rate.count >= (key === accountKey ? 10 : 30))
        throw new Error('Too many sign-in attempts. Wait a minute and try again.');
    }

    const user = this.data.users.find((u) => u.username === username);
    if (!user) {
      this.recordFailedAttempt(clientIp, now);
      throw new Error('Wrong user name or password');
    }

    const candidateHash = hashPassword(passwordInput, user.passwordSalt);
    if (!timingSafeEqualHex(candidateHash, user.passwordHash)) {
      this.recordFailedAttempt(clientIp, now);
      this.recordFailedAttempt(accountKey, now);
      throw new Error('Wrong user name or password');
    }

    this.loginAttempts.delete(clientIp);
    this.loginAttempts.delete(accountKey);
    user.lastLoginAt = now;
    const sessionToken = await this.createSession(user.id);
    return {
      user: await this.toPublicUser(user),
      sessionToken,
    };
  }

  private recordFailedAttempt(clientIp: string, now: number): void {
    const prev = this.loginAttempts.get(clientIp);
    if (!prev || prev.resetAt <= now) {
      this.loginAttempts.set(clientIp, { count: 1, resetAt: now + 60_000 });
    } else {
      prev.count += 1;
    }
  }

  async createSession(userId: string): Promise<string> {
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > now);
    const token = crypto.randomBytes(32).toString('hex');
    this.data.sessions.push({
      hash: sessionHash(token),
      userId,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    await this.save();
    return token;
  }

  async verifySession(token?: string | null): Promise<WebUserPublic | null> {
    if (!token) return null;
    const now = Date.now();
    const given = Buffer.from(sessionHash(token), 'hex');
    const session = this.data.sessions.find((s) => {
      const stored = Buffer.from(s.hash || '', 'hex');
      // Compared in constant time: how long a wrong token takes says nothing about a right one.
      return stored.length === given.length && crypto.timingSafeEqual(stored, given) && s.expiresAt > now;
    });
    if (!session) return null;
    const user = this.data.users.find((u) => u.id === session.userId);
    if (!user) return null;
    return this.toPublicUser(user);
  }

  async revokeSession(token?: string | null): Promise<void> {
    if (!token) return;
    const before = this.data.sessions.length;
    const hash = sessionHash(token);
    this.data.sessions = this.data.sessions.filter((s) => s.hash !== hash);
    if (this.data.sessions.length !== before) {
      await this.save();
    }
  }

  async listUsers(): Promise<WebUserPublic[]> {
    const result: WebUserPublic[] = [];
    for (const u of this.data.users) {
      result.push(await this.toPublicUser(u));
    }
    return result;
  }

  async createUserByAdmin(input: {
    username: string;
    password: string;
    displayName?: string;
    role?: 'admin' | 'member';
  }): Promise<WebUserPublic> {
    const user = await this.createUserInternal({
      username: input.username,
      password: input.password,
      displayName: input.displayName,
      role: input.role ?? 'member',
    });
    return this.toPublicUser(user);
  }

  async deleteUserByAdmin(targetUserId: string, actorUserId: string): Promise<void> {
    if (targetUserId === actorUserId) {
      throw new Error('You cannot remove the account you are signed in with');
    }
    const target = this.data.users.find((u) => u.id === targetUserId);
    if (!target) return;
    this.data.users = this.data.users.filter((u) => u.id !== targetUserId);
    this.data.sessions = this.data.sessions.filter(
      (s) => s.userId !== targetUserId,
    );
    await this.save();
  }

  async createInvite(input: {
    createdBy: string;
    role?: 'admin' | 'member';
    note?: string;
    maxUses?: number;
    ttlMs?: number;
  }): Promise<WebInviteRecord> {
    const now = Date.now();
    const record: WebInviteRecord = {
      token: `inv_${crypto.randomBytes(16).toString('base64url')}`,
      role: input.role ?? 'member',
      note: input.note?.trim() || undefined,
      createdBy: input.createdBy,
      createdAt: now,
      expiresAt: now + (input.ttlMs ?? DEFAULT_INVITE_TTL_MS),
      maxUses: Math.max(1, input.maxUses ?? 10),
      usedCount: 0,
    };
    this.data.invites.push(record);
    await this.save();
    return record;
  }

  listInvites(): WebInviteRecord[] {
    const now = Date.now();
    return this.data.invites.filter(
      (inv) => inv.expiresAt > now && inv.usedCount < inv.maxUses,
    );
  }

  async revokeInvite(token: string): Promise<void> {
    const clean = token.trim();
    if (!clean) return;
    const before = this.data.invites.length;
    this.data.invites = this.data.invites.filter((i) => i.token !== clean);
    if (this.data.invites.length !== before) {
      await this.save();
    }
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    /** The session the change is made from: it stays; every other session of this user ends. */
    keepSessionToken?: string | null,
  ): Promise<void> {
    const user = this.data.users.find((u) => u.id === userId);
    if (!user) {
      throw new Error('User not found');
    }
    const candidateHash = hashPassword(currentPassword, user.passwordSalt);
    if (!timingSafeEqualHex(candidateHash, user.passwordHash)) {
      throw new Error('The current password is wrong');
    }
    this.validatePassword(newPassword);
    const newSalt = crypto.randomBytes(16).toString('hex');
    user.passwordSalt = newSalt;
    user.passwordHash = hashPassword(newPassword, newSalt);
    // A new password ends every other sign-in: whoever had the old one is out, not for another 30 days.
    const keep = keepSessionToken ? sessionHash(keepSessionToken) : undefined;
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId || s.hash === keep);
    await this.save();
  }

  async redeemInvite(input: {
    inviteToken: string;
    username: string;
    password: string;
    displayName?: string;
  }): Promise<{ user: WebUserPublic; sessionToken: string }> {
    const now = Date.now();
    const cleanToken = input.inviteToken.trim();
    const invite = this.data.invites.find(
      (i) =>
        i.token === cleanToken &&
        i.expiresAt > now &&
        i.usedCount < i.maxUses,
    );
    if (!invite) {
      throw new Error('The invite link is not valid, or has expired');
    }

    const user = await this.createUserInternal({
      username: input.username,
      password: input.password,
      displayName: input.displayName,
      role: invite.role,
    });
    invite.usedCount += 1;
    await this.save();

    const sessionToken = await this.createSession(user.id);
    return {
      user: await this.toPublicUser(user),
      sessionToken,
    };
  }
}
