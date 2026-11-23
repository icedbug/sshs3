import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../storage/atomicFile';

export interface WebUserRecord {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
  lastLoginAt?: number;
  authSource?: 'local' | 'oidc';
  ssoIssuer?: string;
  ssoSubject?: string;
  ssoEmail?: string;
  ssoGroups?: string[];
  disabled?: boolean;
  disabledAt?: number;
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
  authSource?: 'local' | 'oidc';
  ssoIssuer?: string;
  ssoSubject?: string;
  ssoEmail?: string;
  ssoGroups?: string[];
  disabled?: boolean;
  disabledAt?: number;
}

export interface OidcClaims {
  sub: string;
  iss?: string;
  email?: string;
  preferred_username?: string;
  name?: string;
  groups?: string[];
  roles?: string[];
  [key: string]: unknown;
}

export interface MappedOidcIdentity {
  subject: string;
  issuer?: string;
  username: string;
  displayName: string;
  email?: string;
  role: 'admin' | 'member';
  groups: string[];
}

export interface OidcClaimMappingConfig {
  /** Expected OIDC issuer URL (exact normalized match if configured). */
  issuer?: string;
  /** Claim key used for username (default: 'preferred_username'). */
  usernameClaim?: string;
  /** Claim key used for display name (default: 'name'). */
  displayNameClaim?: string;
  /** Claim key used for groups/roles (default: 'groups', also reads 'roles'). */
  groupsClaim?: string;
  /** Group or role names that grant 'admin' role. */
  adminGroups?: string[];
  /** Group or role names required to allow access (if non-empty). */
  requiredGroups?: string[];
  /** Custom mapping hook for IdP-specific claim shapes. */
  customMapper?: (claims: OidcClaims) => Partial<MappedOidcIdentity>;
}

/** An account, as far as deciding who may be a second approver needs it. */
export type PeerAccount = Pick<WebUserPublic, 'id' | 'username' | 'displayName' | 'role' | 'ssoGroups' | 'disabled'>;

export interface PeerApprovalPolicyInput {
  requesterId: string;
  requesterUsername?: string;
  approver: Pick<WebUserPublic, 'id' | 'username' | 'role' | 'ssoGroups' | 'disabled'>;
  targetEnv?: string;
  targetTags?: string[];
  requireAdminForProd?: boolean;
  requiredApprovals?: number;
  existingApprovals?: Array<{ actorId?: string; actor?: string; allowed: boolean }>;
  /** Additional SSO group names permitted to approve prod changes. */
  approverGroups?: string[];
}

export interface PeerApprovalDecision {
  authorized: boolean;
  reason?: string;
  satisfiedCount: number;
  requiredCount: number;
  remainingApprovals: number;
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

/**
 * Sign-ins of an account that ended: one of them (signing out), all but one (a new password, which
 * keeps the sign-in it was changed from), or all (turned off, removed). `only` and `except` are the
 * keys of sessions (WebAuthService.sessionKey), never the tokens.
 */
export interface SessionsEnded {
  userId: string;
  only?: string;
  except?: string;
}

/** The limiter's answer. `first` is true once per address or account and minute: when it starts refusing. */
export class TooManySignInAttempts extends Error {
  constructor(readonly first: boolean) {
    super('Too many sign-in attempts. Wait a minute and try again.');
    this.name = 'TooManySignInAttempts';
  }
}

/** A salt for the password work done for a name that has no account, so both cases take as long. */
const NO_ACCOUNT_SALT = '00'.repeat(16);

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
    execFileSync(command, args, { timeout: 10_000, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, SSHS3_PRIVATE_KEY_PATH: file } }),
): boolean {
  if (platform !== 'win32') return true;
  // Replace the DACL in one operation. Changing inheritance and granting the user access
  // with icacls leaves behind any other accounts with explicit grants.
  const apply = [
    "$ErrorActionPreference = 'Stop'",
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$acl = [IO.File]::GetAccessControl($env:SSHS3_PRIVATE_KEY_PATH, [Security.AccessControl.AccessControlSections]::Access)',
    "$acl.SetSecurityDescriptorSddlForm(('D:P(A;;FA;;;' + $sid + ')'), [Security.AccessControl.AccessControlSections]::Access)",
    '[IO.File]::SetAccessControl($env:SSHS3_PRIVATE_KEY_PATH, $acl)',
  ].join('\n');
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', apply]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The key pair in `sshDir` (id_ed25519 and id_ed25519.pub), made when there is none or when asked to
 * rotate it. An account's key and the chat agent's key are made the same way; the chat agent's folder
 * is outside the accounts' folders, so it is kept by this function and not by an account record.
 * `restricted` remembers the keys already restricted in this process, so Windows is not asked again.
 */
export async function ensureKeyPairAt(
  sshDir: string,
  comment: string,
  options: { rotate?: boolean; restricted?: Set<string> } = {},
): Promise<{ privateKeyPath: string; publicKey: string }> {
  const privPath = path.join(sshDir, 'id_ed25519');
  const pubPath = path.join(sshDir, 'id_ed25519.pub');
  const restricted = options.restricted ?? new Set<string>();
  await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });

  if (!options.rotate && fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    // A key written before sshs3 restricted it (on Windows) is put right once, when it is next asked for.
    if (!restricted.has(privPath) && restrictPrivateKeyFile(privPath)) restricted.add(privPath);
    const pub = (await fsp.readFile(pubPath, 'utf8')).trim();
    return { privateKeyPath: privPath, publicKey: pub };
  }

  const { privateKeyPem, publicKeyLine } = generateOpenSshEd25519KeyPair(comment);
  // Written whole and then moved into place: a crash or a full disk while rotating leaves the old key,
  // never half of a new one. The mode is set on the new file, whatever the old one had.
  await writeFileAtomic(privPath, privateKeyPem, { mode: 0o600 });
  if (restrictPrivateKeyFile(privPath)) restricted.add(privPath);
  await writeFileAtomic(pubPath, `${publicKeyLine}\n`, { mode: 0o644 });

  const pub = (await fsp.readFile(pubPath, 'utf8')).trim();
  return { privateKeyPath: privPath, publicKey: pub };
}

/** Ids of the server's own service accounts start with this. No person's account does (theirs start with "usr_"). */
export const SERVICE_ACCOUNT_PREFIX = 'svc_';

const PROD_ENV_PATTERN = /^(prod|production|critical)$/i;
const DEFAULT_PROD_APPROVER_GROUPS = new Set(['approver', 'prod-approver', 'sre-lead', 'admin', 'admins']);

function normalizeOidcIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

function sanitizeOidcUsername(raw: string, fallbackSub: string): string {
  const localPart = raw.includes('@') ? raw.split('@')[0]! : raw;
  const cleaned = localPart
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  if (/^[a-z0-9_.-]{2,40}$/.test(cleaned)) {
    return cleaned;
  }
  const digest = crypto.createHash('sha256').update(fallbackSub).digest('hex').slice(0, 12);
  return `oidc_${digest}`;
}

function collectStringClaimList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Maps OIDC/SSO ID token or UserInfo claims into a normalized sshs3 user identity.
 * Enforces issuer matching and required group membership when configured.
 */
export function mapOidcClaimsToIdentity(
  claims: OidcClaims,
  config: OidcClaimMappingConfig = {},
): MappedOidcIdentity {
  const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!subject) {
    throw new Error('OIDC claims are missing a valid "sub" subject identifier');
  }

  const issuer = typeof claims.iss === 'string' && claims.iss.trim() ? normalizeOidcIssuer(claims.iss) : undefined;
  if (config.issuer) {
    const expected = normalizeOidcIssuer(config.issuer);
    if (!issuer || issuer !== expected) {
      throw new Error('OIDC issuer mismatch');
    }
  }

  const groupsKey = config.groupsClaim || 'groups';
  const groupSet = new Set<string>([
    ...collectStringClaimList(claims[groupsKey]),
    ...collectStringClaimList(claims.roles),
  ]);
  const groups = Array.from(groupSet);
  const lowerGroups = new Set(groups.map((g) => g.toLowerCase()));

  if (config.requiredGroups && config.requiredGroups.length > 0) {
    const hasRequired = config.requiredGroups.some((g) => lowerGroups.has(g.trim().toLowerCase()));
    if (!hasRequired) {
      throw new Error('Missing required SSO group membership');
    }
  }

  const adminGroups = (config.adminGroups && config.adminGroups.length > 0 ? config.adminGroups : ['admin', 'admins'])
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = adminGroups.some((g) => lowerGroups.has(g));

  const usernameKey = config.usernameClaim || 'preferred_username';
  const rawUsername =
    (typeof claims[usernameKey] === 'string' && (claims[usernameKey] as string).trim()) ||
    (typeof claims.email === 'string' && claims.email.trim()) ||
    subject;

  const displayNameKey = config.displayNameClaim || 'name';
  const rawDisplayName =
    (typeof claims[displayNameKey] === 'string' && (claims[displayNameKey] as string).trim()) ||
    (typeof claims.email === 'string' && claims.email.trim()) ||
    rawUsername;

  const base: MappedOidcIdentity = {
    subject,
    ...(issuer ? { issuer } : {}),
    username: sanitizeOidcUsername(rawUsername, subject),
    displayName: rawDisplayName,
    ...(typeof claims.email === 'string' && claims.email.trim() ? { email: claims.email.trim() } : {}),
    role: isAdmin ? 'admin' : 'member',
    groups,
  };

  if (config.customMapper) {
    const override = config.customMapper(claims);
    return {
      ...base,
      ...override,
      subject: override.subject ?? base.subject,
      username: override.username ? sanitizeOidcUsername(override.username, subject) : base.username,
      displayName: override.displayName ?? base.displayName,
      role: override.role === 'admin' ? 'admin' : override.role === 'member' ? 'member' : base.role,
      groups: Array.isArray(override.groups) ? override.groups : base.groups,
    };
  }

  return base;
}

/**
 * Returns true if the target environment or tags represent production/critical infrastructure.
 */
export function isProdTargetContext(targetEnv?: string, targetTags?: string[]): boolean {
  if (targetEnv && PROD_ENV_PATTERN.test(targetEnv.trim())) {
    return true;
  }
  if (Array.isArray(targetTags)) {
    return targetTags.some((t) => typeof t === 'string' && PROD_ENV_PATTERN.test(t.trim()));
  }
  return false;
}

/**
 * Evaluates role-based peer approval authorization with strict Separation of Duties (SoD).
 * Prevents self-approval and enforces admin/approver roles for production targets.
 */
export function evaluatePeerApproval(input: PeerApprovalPolicyInput): PeerApprovalDecision {
  const requiredCount = Math.max(1, input.requiredApprovals ?? 1);
  const distinctApprovers = new Set<string>();
  for (const existing of input.existingApprovals ?? []) {
    if (!existing.allowed) continue;
    const key = existing.actorId?.trim() || existing.actor?.trim();
    if (!key) continue;
    if (key === input.requesterId || (input.requesterUsername && key.toLowerCase() === input.requesterUsername.toLowerCase())) {
      continue;
    }
    distinctApprovers.add(key);
  }

  const satisfiedSoFar = distinctApprovers.size;

  if (input.approver.disabled) {
    return {
      authorized: false,
      reason: 'Approver account is disabled',
      satisfiedCount: satisfiedSoFar,
      requiredCount,
      remainingApprovals: Math.max(0, requiredCount - satisfiedSoFar),
    };
  }

  if (
    input.approver.id === input.requesterId ||
    (input.requesterUsername && input.approver.username.toLowerCase() === input.requesterUsername.trim().toLowerCase())
  ) {
    return {
      authorized: false,
      reason: 'Self-approval is not permitted (separation of duties)',
      satisfiedCount: satisfiedSoFar,
      requiredCount,
      remainingApprovals: Math.max(0, requiredCount - satisfiedSoFar),
    };
  }

  const isProd = isProdTargetContext(input.targetEnv, input.targetTags);
  const requireAdminForProd = input.requireAdminForProd ?? true;
  if (isProd && requireAdminForProd) {
    const allowedGroupSet = new Set(
      (input.approverGroups && input.approverGroups.length > 0
        ? input.approverGroups
        : Array.from(DEFAULT_PROD_APPROVER_GROUPS)
      ).map((g) => g.trim().toLowerCase()),
    );
    const hasApproverGroup = (input.approver.ssoGroups ?? []).some((g) =>
      allowedGroupSet.has(g.trim().toLowerCase()),
    );
    if (input.approver.role !== 'admin' && !hasApproverGroup) {
      return {
        authorized: false,
        reason: 'Production peer approval requires an admin or authorized approver role',
        satisfiedCount: satisfiedSoFar,
        requiredCount,
        remainingApprovals: Math.max(0, requiredCount - satisfiedSoFar),
      };
    }
  }

  const approverKey = input.approver.id || input.approver.username;
  if (distinctApprovers.has(approverKey)) {
    return {
      authorized: false,
      reason: 'This approver has already recorded an approval',
      satisfiedCount: satisfiedSoFar,
      requiredCount,
      remainingApprovals: Math.max(0, requiredCount - satisfiedSoFar),
    };
  }

  distinctApprovers.add(approverKey);
  const satisfiedCount = distinctApprovers.size;
  return {
    authorized: true,
    satisfiedCount,
    requiredCount,
    remainingApprovals: Math.max(0, requiredCount - satisfiedCount),
  };
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
  private loginAttempts = new Map<string, { count: number; resetAt: number; refusing?: boolean }>();
  /** When the failed attempts are next looked through for ones that have run out. */
  private attemptsSweepAt = 0;
  private sessionsEndedListener?: (ended: SessionsEnded) => void;

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

  /**
   * Whoever holds connections that were opened with a sign-in is told here when sign-ins end, so that
   * they are closed with it: a WebSocket is checked when it is opened and would otherwise stay open.
   */
  onSessionsEnded(listener: (ended: SessionsEnded) => void): void {
    this.sessionsEndedListener = listener;
  }

  private sessionsEnded(ended: SessionsEnded): void {
    try {
      this.sessionsEndedListener?.(ended);
    } catch {
      // Closing connections must never undo the sign-out that caused it.
    }
  }

  /** What a session is known by here: the hash of its token. Nothing can be signed in with it. */
  sessionKey(token?: string | null): string | undefined {
    return token ? sessionHash(token) : undefined;
  }

  /** Whether the session with this key still holds: it exists, has not run out, and its account is there and on. */
  isSessionActive(key: string | undefined): boolean {
    if (!key) return false;
    const now = Date.now();
    const session = this.data.sessions.find((s) => s.hash === key && s.expiresAt > now);
    if (!session) return false;
    const user = this.data.users.find((u) => u.id === session.userId);
    return Boolean(user && !user.disabled);
  }

  /** How many addresses and accounts have failed attempts counted against them right now. */
  countedSignInAttempts(): number {
    return this.loginAttempts.size;
  }

  /** How many accounts this server has. */
  userCount(): number {
    return this.data.users.length;
  }

  /** The accounts as far as deciding who may approve for whom needs them: who they are and what they may do. Nothing secret. */
  accountsBrief(): PeerAccount[] {
    return this.data.users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      ...(u.ssoGroups ? { ssoGroups: [...u.ssoGroups] } : {}),
      ...(u.disabled ? { disabled: true } : {}),
    }));
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
    return ensureKeyPairAt(this.getUserSshDir(userId), `${username}@sshs3-web`, {
      rotate: forceRotate,
      restricted: this.restrictedKeys,
    });
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
      ...(user.authSource ? { authSource: user.authSource } : {}),
      ...(user.ssoIssuer ? { ssoIssuer: user.ssoIssuer } : {}),
      ...(user.ssoSubject ? { ssoSubject: user.ssoSubject } : {}),
      ...(user.ssoEmail ? { ssoEmail: user.ssoEmail } : {}),
      ...(user.ssoGroups ? { ssoGroups: user.ssoGroups } : {}),
      ...(user.disabled ? { disabled: user.disabled, disabledAt: user.disabledAt } : {}),
    };
  }

  async getUserById(userId: string): Promise<WebUserPublic | null> {
    if (!userId) return null;
    const user = this.data.users.find((u) => u.id === userId);
    if (!user || user.disabled) return null;
    return this.toPublicUser(user);
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
    // Counts that have run out are forgotten, at most once a minute: every address that ever failed
    // would otherwise stay in memory until the server stops.
    if (now >= this.attemptsSweepAt) {
      this.attemptsSweepAt = now + 60_000;
      for (const [key, rate] of this.loginAttempts) if (rate.resetAt <= now) this.loginAttempts.delete(key);
    }
    for (const key of [clientIp, accountKey]) {
      const rate = this.loginAttempts.get(key);
      if (rate && rate.resetAt > now && rate.count >= (key === accountKey ? 10 : 30)) {
        const first = !rate.refusing;
        rate.refusing = true;
        throw new TooManySignInAttempts(first);
      }
    }

    const user = this.data.users.find((u) => u.username === username);
    if (!user || !user.passwordHash || !user.passwordSalt) {
      // The same password work as for a name that has an account: how long the answer takes says nothing about which names exist.
      hashPassword(passwordInput, NO_ACCOUNT_SALT);
      this.recordFailedAttempt(clientIp, now);
      throw new Error('Wrong user name or password');
    }

    const candidateHash = hashPassword(passwordInput, user.passwordSalt);
    if (!timingSafeEqualHex(candidateHash, user.passwordHash)) {
      this.recordFailedAttempt(clientIp, now);
      this.recordFailedAttempt(accountKey, now);
      throw new Error('Wrong user name or password');
    }

    if (user.disabled) {
      throw new Error('This account has been disabled');
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
    if (!user || user.disabled) return null;
    return this.toPublicUser(user);
  }

  async revokeAllSessionsForUser(userId: string): Promise<number> {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== userId);
    const removed = before - this.data.sessions.length;
    this.sessionsEnded({ userId });
    if (removed > 0) {
      await this.save();
    }
    return removed;
  }

  activeSessionCount(userId?: string): number {
    const now = Date.now();
    return this.data.sessions.filter(
      (s) => s.expiresAt > now && (!userId || s.userId === userId),
    ).length;
  }

  /**
   * Provisions or updates an OIDC/SSO-authenticated user from verified IdP claims
   * and issues a server session. Never silently merges with an unrelated local password account.
   */
  async upsertOidcUser(
    claims: OidcClaims,
    config: OidcClaimMappingConfig = {},
  ): Promise<{ user: WebUserPublic; sessionToken: string; created: boolean }> {
    const identity = mapOidcClaimsToIdentity(claims, config);
    const now = Date.now();

    let record = this.data.users.find(
      (u) =>
        u.authSource === 'oidc' &&
        u.ssoSubject === identity.subject &&
        (u.ssoIssuer || '') === (identity.issuer || ''),
    );

    if (record?.disabled) {
      throw new Error('This account has been disabled');
    }

    let created = false;
    if (!record) {
      // Prevent silent takeover of an existing local or distinct-subject account
      let candidateUsername = identity.username;
      if (this.data.users.some((u) => u.username === candidateUsername)) {
        const suffix = crypto
          .createHash('sha256')
          .update(`${identity.issuer || ''}:${identity.subject}`)
          .digest('hex')
          .slice(0, 6);
        candidateUsername = `${candidateUsername.slice(0, 33)}_${suffix}`;
      }
      record = {
        id: `usr_${crypto.randomBytes(8).toString('hex')}`,
        username: this.normalizeUsername(candidateUsername),
        displayName: identity.displayName || candidateUsername,
        role: identity.role,
        passwordSalt: '',
        passwordHash: '',
        createdAt: now,
        lastLoginAt: now,
        authSource: 'oidc',
        ssoIssuer: identity.issuer,
        ssoSubject: identity.subject,
        ssoEmail: identity.email,
        ssoGroups: identity.groups,
      };
      this.data.users.push(record);
      await this.ensureUserSshKey(record.id, record.username);
      created = true;
    } else {
      record.displayName = identity.displayName || record.displayName;
      record.role = identity.role;
      record.ssoEmail = identity.email ?? record.ssoEmail;
      record.ssoGroups = identity.groups;
      record.lastLoginAt = now;
    }

    await this.save();
    const sessionToken = await this.createSession(record.id);
    return {
      user: await this.toPublicUser(record),
      sessionToken,
      created,
    };
  }

  /**
   * SCIM/SSO offboarding hook: marks the user disabled and immediately revokes all sessions.
   */
  async deprovisionUser(
    userIdOrSubject: string,
  ): Promise<{ deprovisioned: boolean; userId?: string; revokedSessions: number }> {
    const clean = userIdOrSubject.trim();
    if (!clean) return { deprovisioned: false, revokedSessions: 0 };
    const user = this.data.users.find(
      (u) => u.id === clean || u.ssoSubject === clean || u.username === clean.toLowerCase(),
    );
    if (!user) return { deprovisioned: false, revokedSessions: 0 };
    user.disabled = true;
    user.disabledAt = Date.now();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== user.id);
    const revokedSessions = before - this.data.sessions.length;
    this.sessionsEnded({ userId: user.id });
    await this.save();
    return { deprovisioned: true, userId: user.id, revokedSessions };
  }

  async reactivateUser(userId: string): Promise<boolean> {
    const user = this.data.users.find((u) => u.id === userId);
    if (!user) return false;
    delete user.disabled;
    delete user.disabledAt;
    await this.save();
    return true;
  }

  async revokeSession(token?: string | null): Promise<void> {
    if (!token) return;
    const before = this.data.sessions.length;
    const hash = sessionHash(token);
    const ended = this.data.sessions.find((s) => s.hash === hash);
    this.data.sessions = this.data.sessions.filter((s) => s.hash !== hash);
    if (ended) this.sessionsEnded({ userId: ended.userId, only: hash });
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
    if (targetUserId.startsWith(SERVICE_ACCOUNT_PREFIX)) {
      throw new Error('The chat agent belongs to the server and cannot be removed');
    }
    if (targetUserId === actorUserId) {
      throw new Error('You cannot remove the account you are signed in with');
    }
    const target = this.data.users.find((u) => u.id === targetUserId);
    if (!target) return;
    this.data.users = this.data.users.filter((u) => u.id !== targetUserId);
    this.data.sessions = this.data.sessions.filter(
      (s) => s.userId !== targetUserId,
    );
    this.sessionsEnded({ userId: targetUserId });
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
    this.sessionsEnded(keep ? { userId, except: keep } : { userId });
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

    // The use is taken now, before anything is waited for: several requests with the same invite at
    // once each find it with the uses that are really left. It is given back when no account was made.
    invite.usedCount += 1;
    let user: WebUserRecord;
    try {
      user = await this.createUserInternal({
        username: input.username,
        password: input.password,
        displayName: input.displayName,
        role: invite.role,
      });
    } catch (error) {
      // When in doubt the use stays taken: an invite makes too few accounts rather than too many.
      const wanted = input.username.trim().toLowerCase();
      if (!this.data.users.some((u) => u.username === wanted && u.createdAt >= now)) invite.usedCount -= 1;
      throw error;
    }
    await this.save();

    const sessionToken = await this.createSession(user.id);
    return {
      user: await this.toPublicUser(user),
      sessionToken,
    };
  }
}
