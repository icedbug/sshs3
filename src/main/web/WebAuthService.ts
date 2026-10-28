import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

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
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    ...lines,
    '-----END OPENSSH PRIVATE KEY-----',
    '',
  ].join('\n');

  return { privateKeyPem, publicKeyLine };
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
          sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
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

  private async save(): Promise<void> {
    await fsp.mkdir(this.baseDataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.authFilePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), {
      mode: 0o600,
    });
    await fsp.rename(tmp, this.authFilePath);
  }

  hasAnyUsers(): boolean {
    return this.data.users.length > 0;
  }

  getUserDataDir(userId: string): string {
    const safeId = userId.replace(/[^a-zA-Z0-9_-]/g, '');
    return path.join(this.baseDataDir, 'users', safeId);
  }

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
      const pub = (await fsp.readFile(pubPath, 'utf8')).trim();
      return { privateKeyPath: privPath, publicKey: pub };
    }

    const comment = `${username}@sshs3-web`;
    const { privateKeyPem, publicKeyLine } =
      generateOpenSshEd25519KeyPair(comment);
    await fsp.writeFile(privPath, privateKeyPem, { mode: 0o600 });
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
      throw new Error('Ogiltig privat SSH-nyckel (måste vara i OpenSSH/PEM-format)');
    }
    const sshDir = this.getUserSshDir(userId);
    const privPath = this.getUserPrivateKeyPath(userId);
    const pubPath = this.getUserPublicKeyPath(userId);
    await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(privPath, `${trimmedPriv}\n`, { mode: 0o600 });

    let derivedPub = publicKeyLine?.trim() || '';
    if (!derivedPub) {
      try {
        derivedPub = execFileSync('ssh-keygen', ['-y', '-f', privPath], {
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
      } catch {
        derivedPub = 'Egen privat SSH-nyckel installerad';
      }
    }
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
        'Användarnamn måste vara 2–40 tecken (a-z, 0-9, punkt, bindestreck eller understreck)',
      );
    }
    return clean;
  }

  private validatePassword(password: string): void {
    if (typeof password !== 'string' || password.length < 6) {
      throw new Error('Lösenordet måste vara minst 6 tecken långt');
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
      throw new Error(`Användarnamnet "${username}" finns redan`);
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
      throw new Error('Admin-konto är redan konfigurerat på denna server');
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
    const rate = this.loginAttempts.get(clientIp);
    if (rate && rate.resetAt > now && rate.count >= 15) {
      throw new Error('För många inloggningsförsök. Vänta en minut och försök igen.');
    }

    const username = usernameInput.trim().toLowerCase();
    const user = this.data.users.find((u) => u.username === username);
    if (!user) {
      this.recordFailedAttempt(clientIp, now);
      throw new Error('Felaktigt användarnamn eller lösenord');
    }

    const candidateHash = hashPassword(passwordInput, user.passwordSalt);
    if (!timingSafeEqualHex(candidateHash, user.passwordHash)) {
      this.recordFailedAttempt(clientIp, now);
      throw new Error('Felaktigt användarnamn eller lösenord');
    }

    this.loginAttempts.delete(clientIp);
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
      token,
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
    const session = this.data.sessions.find(
      (s) => s.token === token && s.expiresAt > now,
    );
    if (!session) return null;
    const user = this.data.users.find((u) => u.id === session.userId);
    if (!user) return null;
    return this.toPublicUser(user);
  }

  async revokeSession(token?: string | null): Promise<void> {
    if (!token) return;
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.token !== token);
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
      throw new Error('Du kan inte ta bort ditt eget inloggade konto');
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
      throw new Error('Invite-länken är ogiltig eller har gått ut');
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
