import React, { useEffect, useState } from 'react';
import { pkcs11PlaceholderPath } from '../../lib/smartcard';
import {
  Server,
  Cloud,
  FolderOpen,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  KeyRound,
} from 'lucide-react';
import type { StorageConnectConfig } from '@shared/types/ipc';
import type { SSHAuthType, SSHConnectionConfig, DetectedSmartcardLib } from '@shared/types/ssh';
import type { SFTPConfig, S3Config, S3AuthMode, S3SsoConfig } from '@shared/types/storage';
import type { AwsSsoAccount, AwsSsoAccountRole } from '@shared/types/aws';
import { describeIpcError } from '../../lib/format';

export interface SyncTargetDraft {
  type: 'sftp' | 's3';
  // SFTP fields
  host: string;
  port: number;
  username: string;
  authType: SSHAuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  agentPath?: string;
  pkcs11LibPath?: string;
  proxyJump?: string;

  // S3 fields
  endpoint?: string;
  region: string;
  authMode: S3AuthMode;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
  sso?: S3SsoConfig;

  // Common: where under the connection the .sshs3 folder is created.
  // For S3 this MUST include the bucket (S3Config carries no bucket itself —
  // an S3 "remotePath" is always "bucket/key...").
  remoteBasePath: string;
}

// eslint-disable-next-line react-refresh/only-export-components -- helper used by companion sync modals
export function emptySyncTargetDraft(): SyncTargetDraft {
  return {
    type: 'sftp',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    password: '',
    endpoint: '',
    region: 'us-east-1',
    authMode: 'static',
    accessKeyId: '',
    secretAccessKey: '',
    remoteBasePath: '',
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- helper used by companion sync modals
export function draftFromTargetConfig(
  target?: { type: 'sftp' | 's3'; sftpConfig?: SFTPConfig; s3Config?: S3Config },
  remoteBasePath = ''
): SyncTargetDraft {
  const draft = emptySyncTargetDraft();
  draft.remoteBasePath = remoteBasePath;
  if (!target) return draft;

  draft.type = target.type;
  if (target.type === 'sftp' && target.sftpConfig) {
    const s = target.sftpConfig;
    draft.host = s.host || '';
    draft.port = s.port || 22;
    draft.username = s.username || '';
    draft.authType = s.authType || 'password';
    draft.password = s.password || '';
    draft.privateKeyPath = s.privateKeyPath || '';
    draft.passphrase = s.passphrase || '';
    draft.agentPath = s.agentPath || '';
    draft.pkcs11LibPath = s.pkcs11LibPath || '';
    draft.proxyJump = s.proxyJump || '';
  } else if (target.type === 's3' && target.s3Config) {
    const s = target.s3Config;
    draft.endpoint = s.endpoint || '';
    draft.region = s.region || 'us-east-1';
    draft.authMode = s.authMode || 'static';
    draft.accessKeyId = s.accessKeyId || '';
    draft.secretAccessKey = s.secretAccessKey || '';
    draft.sessionToken = s.sessionToken || '';
    draft.forcePathStyle = s.forcePathStyle || false;
    draft.sso = s.sso;
  }
  return draft;
}

const SYNC_TARGET_ID = 'sshs3-remote-profile-sync';

// eslint-disable-next-line react-refresh/only-export-components -- helper used by companion sync modals
export function buildSyncTarget(draft: SyncTargetDraft): StorageConnectConfig {
  if (draft.type === 'sftp') {
    return {
      id: SYNC_TARGET_ID,
      name: 'Remote profile sync',
      type: 'sftp',
      sftpConfig: {
        host: draft.host,
        port: draft.port || 22,
        username: draft.username,
        authType: draft.authType || 'password',
        password: draft.password,
        privateKeyPath: draft.privateKeyPath || undefined,
        passphrase: draft.passphrase || undefined,
        agentPath: draft.agentPath || undefined,
        pkcs11LibPath: draft.pkcs11LibPath || undefined,
        proxyJump: draft.proxyJump || undefined,
      },
    };
  }
  return {
    id: SYNC_TARGET_ID,
    name: 'Remote profile sync',
    type: 's3',
    s3Config: {
      id: SYNC_TARGET_ID,
      name: 'Remote profile sync',
      endpoint: draft.endpoint || undefined,
      region: draft.region,
      authMode: draft.authMode || 'static',
      accessKeyId: draft.accessKeyId || '',
      secretAccessKey: draft.secretAccessKey || '',
      sessionToken: draft.sessionToken || undefined,
      forcePathStyle: draft.forcePathStyle,
      sso: draft.sso,
    },
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- helper used by companion sync modals
export function validateSyncTargetDraft(draft: SyncTargetDraft): string | null {
  if (draft.type === 'sftp') {
    if (!draft.host.trim()) return 'Host is required';
    if (!draft.username.trim()) return 'Username is required';
    if (draft.authType === 'password') {
      if (!draft.password) return 'Password is required';
    } else if (draft.authType === 'privateKey') {
      if (!draft.privateKeyPath?.trim()) return 'Private key path is required';
    } else if (draft.authType === 'smartcard') {
      if (!draft.pkcs11LibPath?.trim()) return 'PKCS#11 library path is required';
    }
  } else {
    if (!draft.region.trim()) return 'Region is required';
    if (draft.authMode === 'sso') {
      if (!draft.sso?.startUrl?.trim()) return 'AWS SSO start URL is required';
      if (!draft.sso?.accountId?.trim()) return 'AWS account ID is required';
      if (!draft.sso?.roleName?.trim()) return 'AWS role name is required';
    } else {
      if (!draft.accessKeyId?.trim()) return 'Access key ID is required';
      if (!draft.secretAccessKey) return 'Secret access key is required';
    }
    if (!draft.remoteBasePath.trim()) return 'A bucket (optionally "bucket/prefix") is required for an S3 target';
  }
  return null;
}

const SFTP_AUTH_TYPES: { value: SSHAuthType; label: string }[] = [
  { value: 'password', label: 'Password' },
  { value: 'privateKey', label: 'SSH Key' },
  { value: 'agent', label: 'SSH Agent' },
  { value: 'smartcard', label: 'Smartcard (PKCS#11)' },
];

interface SyncTargetFormProps {
  draft: SyncTargetDraft;
  onChange: (draft: SyncTargetDraft) => void;
  disabled?: boolean;
  /** Overrides the default `window.multissh.testS3Connection` call for "Test Connection" (S3
   * only) — needed by a caller whose draft can have a deliberately blank `secretAccessKey`
   * meaning "keep the saved one" (Team Vault's target editor, which never round-trips the real
   * secret to this form at all — see `TeamVaultStatus.targetConfig`'s doc comment). The default
   * path would otherwise always fail test-connection with "Secret Access Key is required" for
   * exactly the case where a secret genuinely is saved, just not visible here. */
  onTestS3Connection?: (config: S3Config) => Promise<{ success: boolean; error?: string }>;
}

const inputClass =
  'w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 text-xs text-txt-primary outline-none focus:border-sky-500 disabled:opacity-50';
const labelClass = 'text-xs font-medium text-txt-primary';

let fieldIdCounter = 0;

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: (id: string) => React.ReactNode;
}) {
  const [id] = React.useState(() => `sync-target-field-${++fieldIdCounter}`);
  return (
    <div className={`space-y-1.5 ${className ?? ''}`}>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}

export const SyncTargetForm: React.FC<SyncTargetFormProps> = ({ draft, onChange, disabled, onTestS3Connection }) => {
  const [savedProfiles, setSavedProfiles] = useState<{ ssh: SSHConnectionConfig[]; s3: S3Config[] }>({
    ssh: [],
    s3: [],
  });

  const [smartcardLibs, setSmartcardLibs] = useState<DetectedSmartcardLib[]>([]);
  const [detecting, setDetecting] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // AWS SSO state
  const [ssoLoggingIn, setSsoLoggingIn] = useState(false);
  const [ssoAccessToken, setSsoAccessToken] = useState<string | null>(null);
  const [ssoAccounts, setSsoAccounts] = useState<AwsSsoAccount[]>([]);
  const [ssoRoles, setSsoRoles] = useState<AwsSsoAccountRole[]>([]);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [ssoManualEntry, setSsoManualEntry] = useState(false);

  useEffect(() => {
    let mounted = true;
    void window.multissh?.profilesGet?.()
      .then((res) => {
        if (mounted && res) {
          setSavedProfiles(res);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (draft.type !== 'sftp' || draft.authType !== 'smartcard') return;
    let mounted = true;
    setDetecting(true);
    void window.multissh?.smartcardDetect?.()
      .then((libs) => {
        if (mounted && libs) setSmartcardLibs(libs.filter((l) => l.exists));
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setDetecting(false);
      });
    return () => {
      mounted = false;
    };
  }, [draft.type, draft.authType]);

  const set = <K extends keyof SyncTargetDraft>(key: K, value: SyncTargetDraft[K]) => {
    onChange({ ...draft, [key]: value });
    if (testResult) setTestResult(null);
  };

  const updateSso = (patch: Partial<NonNullable<S3SsoConfig>>) => {
    onChange({
      ...draft,
      sso: { startUrl: '', region: draft.region || 'us-east-1', ...draft.sso, ...patch },
    });
    if (testResult) setTestResult(null);
  };

  const browseFor = async (key: 'privateKeyPath' | 'pkcs11LibPath' | 'agentPath') => {
    const path = await window.multissh?.dialogOpenFile?.({ title: 'Choose File' });
    if (path) set(key, path);
  };

  const handleSelectProfile = (profileId: string) => {
    if (!profileId) return;
    const ssh = savedProfiles.ssh.find((p) => p.id === profileId);
    if (ssh) {
      onChange({
        ...draft,
        type: 'sftp',
        host: ssh.host,
        port: ssh.port || 22,
        username: ssh.username,
        authType: ssh.authType || 'password',
        password: ssh.password || '',
        privateKeyPath: ssh.privateKeyPath || '',
        passphrase: ssh.passphrase || '',
        agentPath: ssh.agentPath || '',
        pkcs11LibPath: ssh.pkcs11LibPath || '',
        proxyJump: ssh.proxyJump || '',
        remoteBasePath: ssh.initialPath || draft.remoteBasePath || '',
      });
      setTestResult(null);
      return;
    }
    const s3 = savedProfiles.s3.find((p) => p.id === profileId);
    if (s3) {
      onChange({
        ...draft,
        type: 's3',
        endpoint: s3.endpoint || '',
        region: s3.region || 'us-east-1',
        authMode: s3.authMode || 'static',
        accessKeyId: s3.accessKeyId || '',
        secretAccessKey: s3.secretAccessKey || '',
        sessionToken: s3.sessionToken || '',
        forcePathStyle: s3.forcePathStyle || false,
        sso: s3.sso,
      });
      setTestResult(null);
      return;
    }
  };

  const handleAwsSsoLogin = async () => {
    const startUrl = draft.sso?.startUrl?.trim();
    const region = draft.sso?.region?.trim() || draft.region || 'us-east-1';
    if (!startUrl) return;

    setSsoError(null);
    setSsoAccounts([]);
    setSsoRoles([]);
    setSsoAccessToken(null);
    setSsoManualEntry(false);
    setSsoLoggingIn(true);
    try {
      const { accessToken } = await window.multissh.awsSsoLogin(startUrl, region);
      setSsoAccessToken(accessToken);
      try {
        const accounts = await window.multissh.awsSsoListAccounts(accessToken, region);
        setSsoAccounts(accounts);
      } catch {
        setSsoManualEntry(true);
      }
    } catch (err) {
      setSsoError(describeIpcError(err, 'AWS SSO login failed'));
    } finally {
      setSsoLoggingIn(false);
    }
  };

  const handleSelectAccount = async (accountId: string) => {
    updateSso({ accountId, roleName: undefined });
    setSsoRoles([]);
    if (!ssoAccessToken || !accountId) return;
    const region = draft.sso?.region?.trim() || draft.region || 'us-east-1';
    setLoadingRoles(true);
    try {
      const roles = await window.multissh.awsSsoListRoles(ssoAccessToken, region, accountId);
      setSsoRoles(roles);
    } catch (err) {
      setSsoError(describeIpcError(err, 'Failed to list roles for this account'));
    } finally {
      setLoadingRoles(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      if (draft.type === 'sftp') {
        const res = await window.multissh?.testSSHConnection?.({
          id: 'test',
          name: 'test',
          host: draft.host,
          port: draft.port || 22,
          username: draft.username,
          authType: draft.authType,
          password: draft.password,
          privateKeyPath: draft.privateKeyPath,
          passphrase: draft.passphrase,
          agentPath: draft.agentPath,
          pkcs11LibPath: draft.pkcs11LibPath,
          proxyJump: draft.proxyJump,
        });
        if (res?.success) {
          setTestResult({ success: true, message: 'Connection succeeded!' });
        } else {
          setTestResult({ success: false, message: res?.error || 'Connection failed' });
        }
      } else {
        const s3Config: S3Config = {
          id: 'test',
          name: 'test',
          endpoint: draft.endpoint || undefined,
          region: draft.region,
          authMode: draft.authMode,
          accessKeyId: draft.accessKeyId || '',
          secretAccessKey: draft.secretAccessKey || '',
          sessionToken: draft.sessionToken || undefined,
          forcePathStyle: draft.forcePathStyle,
          sso: draft.sso,
        };
        const res = onTestS3Connection
          ? await onTestS3Connection(s3Config)
          : await window.multissh?.testS3Connection?.(s3Config);
        if (res?.success) {
          setTestResult({ success: true, message: 'Connection to S3 succeeded!' });
        } else {
          setTestResult({ success: false, message: res?.error || 'Connection failed' });
        }
      }
    } catch (err: any) {
      setTestResult({
        success: false,
        message: err?.message || 'Failed to test connection',
      });
    } finally {
      setTesting(false);
    }
  };

  const hasProfiles = savedProfiles.ssh.length > 0 || savedProfiles.s3.length > 0;

  return (
    <div className="space-y-3">
      {hasProfiles && (
        <div className="rounded-lg border border-border-subtle bg-app/60 p-2.5 space-y-1.5">
          <label className="text-xs font-medium text-txt-secondary flex items-center justify-between">
            <span>Autofill from saved profile:</span>
          </label>
          <select
            defaultValue=""
            disabled={disabled}
            onChange={(e) => {
              handleSelectProfile(e.target.value);
              e.target.value = '';
            }}
            className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500"
          >
            <option value="">-- Choose an existing profile --</option>
            {savedProfiles.ssh.length > 0 && (
              <optgroup label="SFTP / SSH Profiles">
                {savedProfiles.ssh.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.username}@{p.host})
                  </option>
                ))}
              </optgroup>
            )}
            {savedProfiles.s3.length > 0 && (
              <optgroup label="S3 Profiles">
                {savedProfiles.s3.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.region})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => set('type', 'sftp')}
          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            draft.type === 'sftp'
              ? 'border-sky-500 bg-sky-500/15 text-sky-300'
              : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
          }`}
        >
          <Server className="h-4 w-4" />
          SFTP server
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => set('type', 's3')}
          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            draft.type === 's3'
              ? 'border-sky-500 bg-sky-500/15 text-sky-300'
              : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
          }`}
        >
          <Cloud className="h-4 w-4" />
          S3 bucket
        </button>
      </div>

      {draft.type === 'sftp' ? (
        <div className="space-y-2.5">
          <div className="grid grid-cols-3 gap-2.5">
            <Field label="Host" className="col-span-2">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  disabled={disabled}
                  value={draft.host}
                  onChange={(e) => set('host', e.target.value)}
                  placeholder="sync.example.com"
                  className={inputClass}
                />
              )}
            </Field>
            <Field label="Port">
              {(id) => (
                <input
                  id={id}
                  type="number"
                  disabled={disabled}
                  value={draft.port}
                  onChange={(e) => set('port', parseInt(e.target.value, 10) || 22)}
                  className={inputClass}
                />
              )}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Username">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  disabled={disabled}
                  value={draft.username}
                  onChange={(e) => set('username', e.target.value)}
                  placeholder="alun or deploy"
                  className={inputClass}
                />
              )}
            </Field>
            <Field label="Authentication">
              {(id) => (
                <select
                  id={id}
                  disabled={disabled}
                  value={draft.authType}
                  onChange={(e) => set('authType', e.target.value as SSHAuthType)}
                  className={inputClass}
                >
                  {SFTP_AUTH_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          {draft.authType === 'password' && (
            <Field label="Password">
              {(id) => (
                <input
                  id={id}
                  type="password"
                  disabled={disabled}
                  autoComplete="new-password"
                  value={draft.password ?? ''}
                  onChange={(e) => set('password', e.target.value)}
                  className={inputClass}
                />
              )}
            </Field>
          )}

          {draft.authType === 'privateKey' && (
            <div className="space-y-2.5">
              <Field label="Private Key">
                {(id) => (
                  <div className="flex gap-1.5">
                    <input
                      id={id}
                      type="text"
                      disabled={disabled}
                      value={draft.privateKeyPath ?? ''}
                      onChange={(e) => set('privateKeyPath', e.target.value)}
                      placeholder="~/.ssh/id_ed25519"
                      className={`${inputClass} font-mono`}
                    />
                    <button
                      aria-label="Browse"
                      type="button"
                      disabled={disabled}
                      onClick={() => void browseFor('privateKeyPath')}
                      className="rounded-lg border border-border-subtle px-2.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-50"
                      title="Browse"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </Field>
              <Field label="Passphrase (optional)">
                {(id) => (
                  <input
                    id={id}
                    type="password"
                    disabled={disabled}
                    autoComplete="new-password"
                    value={draft.passphrase ?? ''}
                    onChange={(e) => set('passphrase', e.target.value)}
                    className={inputClass}
                  />
                )}
              </Field>
            </div>
          )}

          {draft.authType === 'agent' && (
            <Field label="Agent Socket (optional, empty = default SSH_AUTH_SOCK)">
              {(id) => (
                <div className="flex gap-1.5">
                  <input
                    id={id}
                    type="text"
                    disabled={disabled}
                    value={draft.agentPath ?? ''}
                    onChange={(e) => set('agentPath', e.target.value)}
                    placeholder="/tmp/ssh-agent.sock"
                    className={`${inputClass} font-mono`}
                  />
                  <button
                    aria-label="Browse"
                    type="button"
                    disabled={disabled}
                    onClick={() => void browseFor('agentPath')}
                    className="rounded-lg border border-border-subtle px-2.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-50"
                    title="Browse"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </button>
                </div>
              )}
            </Field>
          )}

          {draft.authType === 'smartcard' && (
            <div className="space-y-2.5 rounded-lg border border-border-subtle bg-app/50 p-2.5">
              <Field label="PKCS#11 Library (.so / .dll)">
                {(id) => (
                  <div className="flex gap-1.5">
                    <input
                      id={id}
                      type="text"
                      disabled={disabled}
                      value={draft.pkcs11LibPath ?? ''}
                      onChange={(e) => set('pkcs11LibPath', e.target.value)}
                      placeholder={pkcs11PlaceholderPath()}
                      className={`${inputClass} font-mono`}
                    />
                    <button
                      aria-label="Browse"
                      type="button"
                      disabled={disabled}
                      onClick={() => void browseFor('pkcs11LibPath')}
                      className="rounded-lg border border-border-subtle px-2.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-50"
                      title="Browse"
                    >
                      <FolderOpen className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </Field>

              {detecting ? (
                <div className="flex items-center gap-2 py-1 text-xs text-txt-muted">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Scanning for PKCS#11 modules...
                </div>
              ) : smartcardLibs.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-txt-muted">Detected modules:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {smartcardLibs.map((lib) => (
                      <button
                        key={lib.path}
                        type="button"
                        onClick={() => set('pkcs11LibPath', lib.path)}
                        className="rounded border border-border-subtle bg-app-surface px-2 py-0.5 text-xs text-txt-secondary hover:border-sky-500 hover:text-txt-primary transition-colors"
                      >
                        {lib.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Remote directory (optional)">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  disabled={disabled}
                  value={draft.remoteBasePath}
                  onChange={(e) => set('remoteBasePath', e.target.value)}
                  placeholder="Leave empty for home directory"
                  className={inputClass}
                />
              )}
            </Field>
            <Field label="Jump Host / ProxyJump (optional)">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  disabled={disabled}
                  value={draft.proxyJump ?? ''}
                  onChange={(e) => set('proxyJump', e.target.value)}
                  placeholder="jumpuser@bastion.example.com:22"
                  className={inputClass}
                />
              )}
            </Field>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => set('authMode', 'static')}
              className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                draft.authMode !== 'sso'
                  ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                  : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover'
              }`}
            >
              <KeyRound className="h-3.5 w-3.5" />
              Static Credentials
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => set('authMode', 'sso')}
              className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                draft.authMode === 'sso'
                  ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                  : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover'
              }`}
            >
              <Cloud className="h-3.5 w-3.5" />
              AWS SSO (Identity Center)
            </button>
          </div>

          {draft.authMode !== 'sso' ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Access Key ID">
                  {(id) => (
                    <input
                      id={id}
                      type="text"
                      disabled={disabled}
                      value={draft.accessKeyId ?? ''}
                      onChange={(e) => set('accessKeyId', e.target.value)}
                      className={`${inputClass} font-mono`}
                    />
                  )}
                </Field>
                <Field label="Secret Access Key">
                  {(id) => (
                    <input
                      id={id}
                      type="password"
                      disabled={disabled}
                      autoComplete="new-password"
                      value={draft.secretAccessKey ?? ''}
                      onChange={(e) => set('secretAccessKey', e.target.value)}
                      className={`${inputClass} font-mono`}
                    />
                  )}
                </Field>
              </div>
              <Field label="Session Token (optional, for temporary credentials)">
                {(id) => (
                  <input
                    id={id}
                    type="password"
                    disabled={disabled}
                    autoComplete="new-password"
                    value={draft.sessionToken ?? ''}
                    onChange={(e) => set('sessionToken', e.target.value)}
                    className={`${inputClass} font-mono`}
                  />
                )}
              </Field>
            </div>
          ) : (
            <div className="space-y-2.5 rounded-lg border border-border-subtle bg-app/50 p-3">
              <div className="grid grid-cols-2 gap-2.5">
                <Field label="SSO Start URL">
                  {(id) => (
                    <input
                      id={id}
                      type="text"
                      disabled={disabled}
                      value={draft.sso?.startUrl ?? ''}
                      onChange={(e) => updateSso({ startUrl: e.target.value })}
                      placeholder="https://my-sso.awsapps.com/start"
                      className={`${inputClass} font-mono`}
                    />
                  )}
                </Field>
                <Field label="SSO Region">
                  {(id) => (
                    <input
                      id={id}
                      type="text"
                      disabled={disabled}
                      value={draft.sso?.region ?? draft.region}
                      onChange={(e) => updateSso({ region: e.target.value })}
                      placeholder="us-east-1"
                      className={`${inputClass} font-mono`}
                    />
                  )}
                </Field>
              </div>

              <button
                type="button"
                disabled={!draft.sso?.startUrl?.trim() || ssoLoggingIn || disabled}
                onClick={() => void handleAwsSsoLogin()}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 text-xs text-txt-primary hover:bg-app-surface-hover disabled:opacity-40 transition-colors"
              >
                {ssoLoggingIn && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {ssoLoggingIn ? 'Signing in…' : ssoAccessToken ? 'Sign in again' : 'Sign in with AWS SSO'}
              </button>

              {ssoError && (
                <p role="alert" className="rounded-lg border border-red-800/60 bg-red-950/40 px-2.5 py-1.5 text-xs text-red-300">
                  {ssoError}
                </p>
              )}

              {ssoAccessToken && !ssoManualEntry && (
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Account">
                    {(id) => (
                      <select
                        id={id}
                        disabled={disabled}
                        value={draft.sso?.accountId ?? ''}
                        onChange={(e) => void handleSelectAccount(e.target.value)}
                        className={inputClass}
                      >
                        <option value="">Select an account…</option>
                        {ssoAccounts.map((a) => (
                          <option key={a.accountId} value={a.accountId}>
                            {a.accountName ? `${a.accountName} (${a.accountId})` : a.accountId}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field label="Role">
                    {(id) => (
                      <select
                        id={id}
                        disabled={!draft.sso?.accountId || loadingRoles || disabled}
                        value={draft.sso?.roleName ?? ''}
                        onChange={(e) => updateSso({ roleName: e.target.value })}
                        className={inputClass}
                      >
                        <option value="">{loadingRoles ? 'Loading…' : 'Select a role…'}</option>
                        {ssoRoles.map((r) => (
                          <option key={r.roleName} value={r.roleName}>
                            {r.roleName}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>
              )}

              {(ssoManualEntry || (!ssoAccessToken && (draft.sso?.accountId || draft.sso?.roleName))) && (
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Account ID">
                    {(id) => (
                      <input
                        id={id}
                        type="text"
                        disabled={disabled}
                        value={draft.sso?.accountId ?? ''}
                        onChange={(e) => updateSso({ accountId: e.target.value })}
                        placeholder="123456789012"
                        className={inputClass}
                      />
                    )}
                  </Field>
                  <Field label="Role Name">
                    {(id) => (
                      <input
                        id={id}
                        type="text"
                        disabled={disabled}
                        value={draft.sso?.roleName ?? ''}
                        onChange={(e) => updateSso({ roleName: e.target.value })}
                        placeholder="AdministratorAccess"
                        className={inputClass}
                      />
                    )}
                  </Field>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Region">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  disabled={disabled}
                  value={draft.region}
                  onChange={(e) => set('region', e.target.value)}
                  className={inputClass}
                />
              )}
            </Field>
            <Field label="Bucket (or bucket/prefix)">
              {(id) => (
                <input
                  id={id}
                  type="text"
                  disabled={disabled}
                  value={draft.remoteBasePath}
                  onChange={(e) => set('remoteBasePath', e.target.value)}
                  placeholder="my-bucket/sshs3-sync"
                  className={inputClass}
                />
              )}
            </Field>
          </div>

          <Field label="Endpoint (optional — for MinIO, R2, Wasabi, etc.)">
            {(id) => (
              <input
                id={id}
                type="text"
                disabled={disabled}
                value={draft.endpoint ?? ''}
                onChange={(e) => set('endpoint', e.target.value)}
                placeholder="https://s3.example.com"
                className={inputClass}
              />
            )}
          </Field>

          <label className="flex items-center gap-2 text-xs text-txt-secondary cursor-pointer">
            <input
              type="checkbox"
              disabled={disabled}
              checked={draft.forcePathStyle ?? false}
              onChange={(e) => set('forcePathStyle', e.target.checked)}
              className="rounded border-border-subtle bg-app-input text-sky-500 focus:ring-0"
            />
            <span>Use path-style URLs (required for MinIO and local endpoints)</span>
          </label>
        </div>
      )}

      {/* Test Connection */}
      <div className="flex items-center justify-between pt-1 border-t border-divider">
        <button
          type="button"
          disabled={testing || disabled || (draft.type === 'sftp' ? !draft.host || !draft.username : !draft.region)}
          onClick={() => void handleTestConnection()}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-50 transition-colors"
        >
          {testing && <Loader2 className="h-3 w-3 animate-spin" />}
          <span>{testing ? 'Testing…' : 'Test Connection'}</span>
        </button>

        {testResult && (
          <div
            className={`flex items-center gap-1.5 text-xs ${
              testResult.success ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {testResult.success ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            <span className="truncate max-w-[280px]" title={testResult.message}>
              {testResult.message}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default SyncTargetForm;
