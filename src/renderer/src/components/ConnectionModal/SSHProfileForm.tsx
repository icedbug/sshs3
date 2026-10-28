import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { FIDO2_KEY_FILE_EXISTS_PREFIX } from '@shared/types/ssh';
import type {
  SSHAuthType,
  SSHConnectionConfig,
  DetectedSmartcardLib,
  Fido2KeyType,
  Fido2ResidentKey,
} from '@shared/types/ssh';
import type { DotfilePool } from '@shared/types/dotfiles';
import { describeIpcError } from '../../lib/format';
import { AccessSetupPanel, type AccessState } from '../SSH/AccessSetupPanel';
import { pickDefaultPkcs11Lib, pkcs11PlaceholderPath } from '../../lib/smartcard';
import { IS_WINDOWS } from '../../lib/platform';
import { useEscapeToClose } from '../../lib/useModalDismiss';

interface SSHProfileFormProps {
  initial?: SSHConnectionConfig;
  onSave: (config: SSHConnectionConfig) => void;
  onCancel: () => void;
  /** Master switch from Settings > Files & Storage. When off, the dotfiles pool field is hidden entirely. */
  dotfilesPoolEnabled?: boolean;
  /** Existing folder paths to suggest in the Group/Folder field, via a `<datalist>` — passed for
   * a Team Vault profile, whose folder tree can be arbitrarily deep (`"Acme Infra/Cluster A"`),
   * so autocomplete matters more than for a personal profile's flat, usually-short list. */
  folderSuggestions?: string[];
  /** false for a Team Vault member (not admin): the password/passphrase/proxy-password fields
   * are shown disabled with a placeholder instead of the real value — TeamVaultService enforces
   * the same rule server-side regardless of this prop, this only drives the UI. Defaults to true
   * (personal profiles, and Team Vault admins, can always edit their own secrets). */
  canEditSecret?: boolean;
}

const AUTH_TYPES: { value: SSHAuthType; label: string }[] = [
  { value: 'password', label: 'Password' },
  { value: 'privateKey', label: 'SSH Key' },
  { value: 'agent', label: 'SSH Agent' },
  { value: 'smartcard', label: 'Smartcard (PKCS#11)' },
  { value: 'fido2', label: 'FIDO2 / Security Key' },
];

const FIDO2_KEY_TYPES: { value: Fido2KeyType; label: string }[] = [
  { value: 'ed25519-sk', label: 'ED25519-SK (recommended)' },
  { value: 'ecdsa-sk', label: 'ECDSA-SK (older keys / firmware)' },
];

function emptyConfig(): SSHConnectionConfig {
  return {
    id: crypto.randomUUID(),
    name: '',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
  };
}

export const SSHProfileForm: React.FC<SSHProfileFormProps> = ({
  initial,
  onSave,
  onCancel,
  dotfilesPoolEnabled = false,
  folderSuggestions,
  canEditSecret = true,
}) => {
  const [config, setConfig] = useState<SSHConnectionConfig>(initial ?? emptyConfig());
  const [smartcardLibs, setSmartcardLibs] = useState<DetectedSmartcardLib[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [accessState, setAccessState] = useState<AccessState>('unknown');
  const [saveReminderOpen, setSaveReminderOpen] = useState(false);
  // Escape backs out of the reminder and returns to the form without saving.
  useEscapeToClose(() => setSaveReminderOpen(false), saveReminderOpen);
  const [openInstallSignal, setOpenInstallSignal] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [dotfilePools, setDotfilePools] = useState<DotfilePool[]>([]);
  const [allProfiles, setAllProfiles] = useState<SSHConnectionConfig[]>([]);
  const [proxyJumpMode, setProxyJumpMode] = useState<'none' | 'profile' | 'custom'>(() =>
    initial?.proxyJumpProfileId ? 'profile' : initial?.proxyJump ? 'custom' : 'none'
  );
  const [x11ServerStatus, setX11ServerStatus] = useState<{ running: boolean; display: string; platform?: string } | null>(null);

  // FIDO2 / security key state
  const [fido2ResidentKeys, setFido2ResidentKeys] = useState<Fido2ResidentKey[] | null>(null);
  const [fido2Scanning, setFido2Scanning] = useState(false);
  const [fido2ScanError, setFido2ScanError] = useState<string | null>(null);
  const [fido2GenOpen, setFido2GenOpen] = useState(false);
  const [fido2GenKeyType, setFido2GenKeyType] = useState<Fido2KeyType>('ed25519-sk');
  const [fido2GenResident, setFido2GenResident] = useState(!IS_WINDOWS);
  const [fido2GenVerifyRequired, setFido2GenVerifyRequired] = useState(true);
  const [fido2GenPath, setFido2GenPath] = useState('');
  const [fido2Generating, setFido2Generating] = useState(false);
  const [fido2GenResult, setFido2GenResult] = useState<{ publicKey: string; privateKeyPath: string } | null>(null);
  const [fido2GenError, setFido2GenError] = useState<string | null>(null);
  const hasAutoScannedFido2Ref = useRef(false);
  const fido2GenSectionRef = useRef<HTMLDivElement>(null);
  const [fido2ConfirmDeleteId, setFido2ConfirmDeleteId] = useState<string | null>(null);
  const [fido2DeletingId, setFido2DeletingId] = useState<string | null>(null);
  const [fido2DeleteError, setFido2DeleteError] = useState<string | null>(null);
  const [fido2GenNeedsOverwriteConfirm, setFido2GenNeedsOverwriteConfirm] = useState(false);

  useEffect(() => {
    let mounted = true;
    void window.multissh
      .profilesGet()
      .then(({ ssh }) => {
        if (mounted) setAllProfiles(ssh);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!dotfilesPoolEnabled) return;
    let mounted = true;
    void window.multissh
      .dotfilePoolsGet()
      .then((pools) => {
        if (mounted) setDotfilePools(pools);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [dotfilesPoolEnabled]);

  useEffect(() => {
    if (!config.x11Forwarding) {
      setX11ServerStatus(null);
      return;
    }
    let active = true;
    void window.multissh?.checkX11Server?.(config.x11Display).then((res) => {
      if (active) {
        setX11ServerStatus(res);
      }
    });
    return () => {
      active = false;
    };
  }, [config.x11Forwarding, config.x11Display]);

  useEffect(() => {
    if (config.authType !== 'smartcard') return;
    let mounted = true;
    setDetecting(true);
    void window.multissh
      .smartcardDetect()
      .then((libs) => {
        if (!mounted) return;
        const found = libs.filter((l) => l.exists);
        setSmartcardLibs(found);
        // A smartcard profile with no library yet starts on p11-kit (or the first module found),
        // never on an empty field or a vendor module that is not installed.
        const fallback = pickDefaultPkcs11Lib(found);
        if (fallback) {
          setConfig((prev) =>
            prev.authType === 'smartcard' && !prev.pkcs11LibPath?.trim() ? { ...prev, pkcs11LibPath: fallback } : prev
          );
        }
      })
      .finally(() => {
        if (mounted) setDetecting(false);
      });
    return () => {
      mounted = false;
    };
  }, [config.authType]);

  const update = <K extends keyof SSHConnectionConfig>(key: K, value: SSHConnectionConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const browseFor = async (key: 'privateKeyPath' | 'pkcs11LibPath' | 'agentPath') => {
    const path = await window.multissh.dialogOpenFile({ title: 'Choose File' });
    if (path) update(key, path);
  };

  const scanFido2ResidentKeys = async () => {
    setFido2Scanning(true);
    setFido2ScanError(null);
    try {
      const keys = await window.multissh.fido2ListResidentKeys();
      setFido2ResidentKeys(keys);
    } catch (err) {
      setFido2ScanError(describeIpcError(err, 'Failed to read the connected security key'));
    } finally {
      setFido2Scanning(false);
    }
  };

  const deleteFido2ResidentKey = async (credentialId: string) => {
    setFido2DeletingId(credentialId);
    setFido2DeleteError(null);
    try {
      await window.multissh.fido2DeleteResidentKey(credentialId);
      setFido2ResidentKeys((prev) => (prev ? prev.filter((k) => k.credentialId !== credentialId) : prev));
      setFido2ConfirmDeleteId(null);
    } catch (err) {
      setFido2DeleteError(describeIpcError(err, 'Failed to delete the credential'));
    } finally {
      setFido2DeletingId(null);
    }
  };

  const generateFido2Key = async (overwrite = false) => {
    setFido2Generating(true);
    setFido2GenError(null);
    setFido2GenNeedsOverwriteConfirm(false);
    setFido2GenResult(null);
    try {
      const outPath = fido2GenPath.trim() || `~/.ssh/id_${fido2GenKeyType.replace('-sk', '')}_sk`;
      const resident = fido2GenResident && !IS_WINDOWS;
      const result = await window.multissh.fido2GenerateKey({
        outPath,
        keyType: fido2GenKeyType,
        resident,
        verifyRequired: fido2GenVerifyRequired,
        overwrite,
      });
      setFido2GenResult({ publicKey: result.publicKey, privateKeyPath: result.privateKeyPath });
      update('fido2Resident', resident);
      if (!resident) {
        update('privateKeyPath', result.privateKeyPath);
      } else {
        // Confirms the freshly generated resident credential is actually discoverable now,
        // closing the loop for the "scan found nothing -> generate -> did it work?" flow.
        void scanFido2ResidentKeys();
      }
    } catch (err) {
      const message = describeIpcError(err, 'Failed to generate the key');
      // Electron's ipcRenderer.invoke wraps the original thrown message in its own
      // "Error invoking remote method '<channel>': Error: ..." prefix, so the marker is never at
      // the very start of what the renderer actually sees — search for it instead of anchoring.
      const markerIndex = message.indexOf(FIDO2_KEY_FILE_EXISTS_PREFIX);
      if (markerIndex !== -1) {
        // Typically a stale local stub file left over from a resident credential that was since
        // deleted from the device itself (e.g. via the delete button above) — the file on disk
        // isn't the key material for a resident credential, so overwriting it loses nothing real.
        setFido2GenNeedsOverwriteConfirm(true);
        setFido2GenError(message.slice(markerIndex + FIDO2_KEY_FILE_EXISTS_PREFIX.length).trim());
      } else {
        setFido2GenError(message);
      }
    } finally {
      setFido2Generating(false);
    }
  };

  const startFido2Generate = () => {
    setFido2GenOpen(true);
    setTimeout(() => fido2GenSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  };

  // Auto-scan once when a profile is set to a resident FIDO2 credential, so the user doesn't have
  // to know to click "Scan" themselves — but only once per visit to this auth type, since scanning
  // asks for the device's PIN each time and re-running it on every unrelated re-render would be
  // an annoying, repeated PIN prompt.
  useEffect(() => {
    // Never on Windows: its OpenSSH build can't enumerate resident credentials, so a scan would
    // only ask for the PIN and then fail.
    if (IS_WINDOWS || config.authType !== 'fido2' || !config.fido2Resident) {
      hasAutoScannedFido2Ref.current = false;
      return;
    }
    if (hasAutoScannedFido2Ref.current) return;
    hasAutoScannedFido2Ref.current = true;
    void scanFido2ResidentKeys();
  }, [config.authType, config.fido2Resident]);

  const isValid = config.name.trim() && config.host.trim() && config.username.trim();

  // A saved result no longer applies once anything the chain depends on changes.
  const accessResetKey = [
    config.host,
    config.port ?? 22,
    config.username,
    config.authType,
    config.privateKeyPath ?? '',
    config.pkcs11LibPath ?? '',
    config.fido2Resident ? 1 : 0,
    config.proxyJump ?? '',
    config.proxyJumpProfileId ?? '',
    config.password?.length ?? 0,
  ].join('|');

  // Soft reminder only: a brand-new key-based profile that was never verified on the host. Never blocks saving.
  const needsAccessReminder =
    !initial && config.authType !== 'password' && (accessState === 'unknown' || accessState === 'failed');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!isValid) return;
        if (needsAccessReminder) setSaveReminderOpen(true);
        else onSave(config);
      }}
      className="flex h-full min-h-0 flex-col text-xs text-txt-secondary"
    >
      {/* Scrollable field area is a separate flex child from the footer below
          (UX review #11 bugfix) so a `sticky` footer can never render on top
          of fields revealed by expanding a collapsible section — the footer
          now always has its own permanent, non-overlapping space. */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 pb-6 flex flex-col gap-3.5">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-txt-secondary">
          <span>Profile Name<span className="text-red-400" aria-hidden="true"> *</span></span>
          <input
            required
            value={config.name}
            onChange={(e) => update('name', e.target.value)}
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            placeholder="e.g. Production Server"
          />
        </label>
        <label className="flex flex-col gap-1 text-txt-secondary">
          Group / Folder (optional)
          <input
            value={config.group ?? ''}
            onChange={(e) => update('group', e.target.value)}
            list={folderSuggestions ? 'ssh-folder-suggestions' : undefined}
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            placeholder={folderSuggestions ? 'e.g. Acme Infra/Cluster A' : 'e.g. Production or Web Servers'}
          />
          {folderSuggestions && (
            <datalist id="ssh-folder-suggestions">
              {folderSuggestions.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
          )}
        </label>
      </div>

      <div className="grid grid-cols-[1fr_80px_1fr] gap-2.5">
        <label className="flex flex-col gap-1 text-txt-secondary">
          <span>Hostname / IP<span className="text-red-400" aria-hidden="true"> *</span></span>
          <input
            required
            value={config.host}
            onChange={(e) => update('host', e.target.value)}
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            placeholder="host.example.com"
          />
        </label>
        <label className="flex flex-col gap-1 text-txt-secondary">
          Port
          <input
            type="number"
            value={config.port ?? 22}
            onChange={(e) => update('port', Number(e.target.value) || 22)}
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 text-center"
          />
        </label>
        <label className="flex flex-col gap-1 text-txt-secondary">
          <span>Username<span className="text-red-400" aria-hidden="true"> *</span></span>
          <input
            required
            value={config.username}
            onChange={(e) => update('username', e.target.value)}
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            placeholder="root or deploy"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-txt-secondary">
          Initial SFTP Path (optional)
          <input
            value={config.initialPath ?? ''}
            onChange={(e) => update('initialPath', e.target.value)}
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            placeholder="e.g. /var/www or /home/user"
          />
        </label>
        <label className="flex flex-col gap-1 text-txt-secondary">
          Jump Host / ProxyJump (optional)
          <select
            value={proxyJumpMode === 'none' ? '' : proxyJumpMode === 'custom' ? '__custom__' : config.proxyJumpProfileId ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '') {
                setProxyJumpMode('none');
                update('proxyJumpProfileId', undefined);
                update('proxyJump', undefined);
              } else if (value === '__custom__') {
                setProxyJumpMode('custom');
                update('proxyJumpProfileId', undefined);
              } else {
                setProxyJumpMode('profile');
                update('proxyJumpProfileId', value);
                update('proxyJump', undefined);
              }
            }}
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500"
          >
            <option value="">None</option>
            {allProfiles
              .filter((p) => p.id !== config.id && p.proxyJumpProfileId !== config.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.host}
                </option>
              ))}
            <option value="__custom__">Custom (enter manually)</option>
          </select>
          {proxyJumpMode === 'custom' && (
            <input
              value={config.proxyJump ?? ''}
              onChange={(e) => update('proxyJump', e.target.value)}
              className="mt-1 rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
              placeholder="e.g. jumpuser@bastion.example.com:22"
            />
          )}
        </label>
      </div>

      <label className="flex flex-col gap-1 text-txt-secondary">
        Authentication
        <select
          value={config.authType}
          onChange={(e) => update('authType', e.target.value as SSHAuthType)}
          className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500"
        >
          {AUTH_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      {config.authType === 'password' && (
        <label className="flex flex-col gap-1 text-txt-secondary">
          Password
          <input
            type="password"
            value={config.password ?? ''}
            onChange={(e) => update('password', e.target.value)}
            disabled={!canEditSecret}
            placeholder={!canEditSecret ? (config.hasPassword ? '•••• (admin only)' : 'No password set (admin only)') : undefined}
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <span className="text-xs text-txt-muted">
            {canEditSecret
              ? "Required for SFTP in File Manager and enables automatic login in the terminal. Stored encrypted in the OS Keychain/DPAPI. If left blank, you'll be prompted for the password when connecting."
              : 'Only a Team Vault admin can see or change this password. You can still connect using it.'}
          </span>
        </label>
      )}

      {config.authType === 'privateKey' && (
        <>
          <label className="flex flex-col gap-1 text-txt-secondary">
            Private Key
            <div className="flex gap-1.5">
              <input
                value={config.privateKeyPath ?? ''}
                onChange={(e) => update('privateKeyPath', e.target.value)}
                className="flex-1 rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted font-mono"
                placeholder="~/.ssh/id_ed25519"
              />
              <button
                type="button"
                onClick={() => void browseFor('privateKeyPath')}
                className="rounded-lg border border-border-subtle px-2.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                title="Browse"
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-txt-secondary">
            Passphrase (optional)
            <input
              type="password"
              value={config.passphrase ?? ''}
              onChange={(e) => update('passphrase', e.target.value)}
              disabled={!canEditSecret}
              placeholder={!canEditSecret ? '•••• (admin only)' : undefined}
              className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
        </>
      )}

      {config.authType === 'agent' && (
        <label className="flex flex-col gap-1 text-txt-secondary">
          Agent Socket (optional, empty = SSH_AUTH_SOCK)
          <div className="flex gap-1.5">
            <input
              value={config.agentPath ?? ''}
              onChange={(e) => update('agentPath', e.target.value)}
              className="flex-1 rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted font-mono"
              placeholder="/tmp/ssh-agent.sock"
            />
            <button
              type="button"
              onClick={() => void browseFor('agentPath')}
              className="rounded-lg border border-border-subtle px-2.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              title="Browse"
            >
              <FolderOpen className="h-4 w-4" />
            </button>
          </div>
        </label>
      )}

      {config.authType === 'smartcard' && (
        <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-app-surface-subtle p-3">
          <label className="flex flex-col gap-1 text-txt-secondary">
            PKCS#11 Library (.so / .dll)
            <div className="flex gap-1.5">
              <input
                value={config.pkcs11LibPath ?? ''}
                onChange={(e) => update('pkcs11LibPath', e.target.value)}
                className="flex-1 rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                placeholder={pkcs11PlaceholderPath(pickDefaultPkcs11Lib(smartcardLibs))}
              />
              <button
                type="button"
                onClick={() => void browseFor('pkcs11LibPath')}
                className="rounded-lg border border-border-subtle px-2.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                title="Browse"
              >
                <FolderOpen className="h-4 w-4" />
              </button>
            </div>
          </label>

          {detecting ? (
            <div className="flex items-center gap-2 py-1 text-txt-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Scanning for PKCS#11 libraries...
            </div>
          ) : smartcardLibs.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-txt-muted">Detected modules on system:</span>
              <div className="flex flex-wrap gap-1.5">
                {smartcardLibs.map((lib) => (
                  <button
                    key={lib.path}
                    type="button"
                    onClick={() => update('pkcs11LibPath', lib.path)}
                    className={
                      'rounded-md border px-2 py-0.5 text-left text-xs transition-colors ' +
                      (config.pkcs11LibPath === lib.path
                        ? 'border-sky-500 bg-sky-500/15 text-sky-300 font-medium'
                        : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover')
                    }
                  >
                    <span className="font-semibold">{lib.name}</span>
                    <span className="ml-1 text-2xs text-txt-muted font-mono">{lib.path}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <span className="text-xs text-txt-muted">
              No PKCS#11 libraries automatically detected. Please enter path or browse manually.
            </span>
          )}

          <p className="text-xs text-txt-muted pt-1">
            PIN caching behavior is set globally under Settings &gt; Security &amp; Smartcard.
          </p>
        </div>
      )}

      {config.authType === 'fido2' && (
        <div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-app-surface-subtle p-3">
          <label className="flex items-center gap-2 cursor-pointer text-txt-primary font-medium">
            <input
              type="checkbox"
              checked={config.fido2Resident ?? false}
              disabled={IS_WINDOWS && !config.fido2Resident}
              onChange={(e) => {
                update('fido2Resident', e.target.checked);
                if (e.target.checked) update('privateKeyPath', undefined);
              }}
              className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500 disabled:opacity-40"
            />
            <span>Use a resident (discoverable) credential stored on the device</span>
          </label>

          {IS_WINDOWS && (
            <p className="text-xs text-txt-muted">
              {config.fido2Resident
                ? 'Resident credentials cannot be read back on Windows (its OpenSSH build has no working resident-key support). Untick this and use a key file instead — generate one below.'
                : 'On Windows, use a key file: the key is signed through Windows’ built-in security key support, so you are asked for PIN and touch on each login. Resident credentials are not available here — generate a key file below, or pick an existing one.'}
            </p>
          )}

          {config.fido2Resident && !IS_WINDOWS ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-txt-muted">
                No key file needed — the app loads whatever resident credentials are on the connected
                security key at connect time. It scans automatically below; re-scan any time you swap
                keys or after generating a new one.
              </p>
              <button
                type="button"
                onClick={() => void scanFido2ResidentKeys()}
                disabled={fido2Scanning}
                className="flex w-fit items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1.5 text-xs text-txt-primary hover:bg-app-surface-hover disabled:opacity-40 transition-colors"
              >
                {fido2Scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {fido2Scanning ? 'Touch your security key...' : 'Re-scan connected security key'}
              </button>

              {fido2ScanError && (
                <div className="flex items-center gap-1.5 text-xs text-red-300">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>{fido2ScanError}</span>
                </div>
              )}
              {fido2ResidentKeys && fido2ResidentKeys.length === 0 && (
                <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
                  <p className="text-xs text-amber-200">
                    No resident credentials found on this device yet — this is expected the first time
                    you use a security key with sshs3. Generate one below to get started.
                  </p>
                  <button
                    type="button"
                    onClick={startFido2Generate}
                    className="flex w-fit items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Generate a key now
                  </button>
                </div>
              )}
              {fido2ResidentKeys && fido2ResidentKeys.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-emerald-300">
                    Found {fido2ResidentKeys.length} resident credential(s):
                  </span>
                  {fido2DeleteError && (
                    <div className="flex items-center gap-1.5 text-xs text-red-300">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>{fido2DeleteError}</span>
                    </div>
                  )}
                  {fido2ResidentKeys.map((k) => {
                    const id = k.credentialId ?? k.fingerprint;
                    const confirming = fido2ConfirmDeleteId === id;
                    const deleting = fido2DeletingId === id;
                    return (
                      <div
                        key={id}
                        className="flex items-center justify-between gap-2 rounded-md border border-border-subtle bg-app-surface px-2 py-1 text-xs font-mono text-txt-secondary"
                      >
                        <span className="truncate">
                          <span className="text-txt-primary font-semibold">{k.keyType}</span> {k.fingerprint}{' '}
                          <span className="text-txt-muted">({k.comment})</span>
                        </span>

                        {k.credentialId &&
                          (confirming ? (
                            <span className="flex shrink-0 items-center gap-1">
                              <span className="text-amber-300">Delete?</span>
                              <button
                                type="button"
                                onClick={() => void deleteFido2ResidentKey(k.credentialId!)}
                                disabled={deleting}
                                className="rounded px-1.5 py-0.5 text-red-300 hover:bg-red-500/20 disabled:opacity-40 transition-colors"
                              >
                                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Yes'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setFido2ConfirmDeleteId(null)}
                                disabled={deleting}
                                className="rounded px-1.5 py-0.5 text-txt-secondary hover:bg-app-surface-hover disabled:opacity-40 transition-colors"
                              >
                                No
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setFido2DeleteError(null);
                                setFido2ConfirmDeleteId(id);
                              }}
                              className="shrink-0 rounded p-1 text-txt-muted hover:bg-red-500/20 hover:text-red-300 transition-colors"
                              title="Delete this credential from the security key"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-txt-secondary">
                Key File (id_ed25519_sk / id_ecdsa_sk)
                <div className="flex gap-1.5">
                  <input
                    value={config.privateKeyPath ?? ''}
                    onChange={(e) => update('privateKeyPath', e.target.value)}
                    className="flex-1 rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                    placeholder="~/.ssh/id_ed25519_sk"
                  />
                  <button
                    type="button"
                    onClick={() => void browseFor('privateKeyPath')}
                    className="rounded-lg border border-border-subtle px-2.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                    title="Browse"
                  >
                    <FolderOpen className="h-4 w-4" />
                  </button>
                </div>
              </label>
              <p className="text-xs text-txt-secondary">
                The file manager (SFTP) uses the system OpenSSH client, so this security key also works for file
                transfers. You may be asked to touch the key and enter its PIN when connecting.
              </p>
            </>
          )}

          <div ref={fido2GenSectionRef} className="rounded-lg border border-border-subtle bg-app-surface/50">
            <button
              type="button"
              onClick={() => setFido2GenOpen((o) => !o)}
              className="flex w-full items-center justify-between p-2 text-xs font-medium text-txt-secondary hover:text-txt-primary transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" />
                Generate a new key on this security key
              </span>
              {fido2GenOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>

            {fido2GenOpen && (
              <div className="border-t border-divider p-2.5 space-y-2.5 text-xs">
                <div className="grid grid-cols-2 gap-2.5">
                  <label className="flex flex-col gap-1 text-txt-secondary">
                    Key Type
                    <select
                      value={fido2GenKeyType}
                      onChange={(e) => setFido2GenKeyType(e.target.value as Fido2KeyType)}
                      className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500"
                    >
                      {FIDO2_KEY_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-txt-secondary">
                    Output Path
                    <input
                      value={fido2GenPath}
                      onChange={(e) => setFido2GenPath(e.target.value)}
                      placeholder={`~/.ssh/id_${fido2GenKeyType.replace('-sk', '')}_sk`}
                      className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                    />
                  </label>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 cursor-pointer text-txt-primary">
                    <input
                      type="checkbox"
                      checked={fido2GenResident && !IS_WINDOWS}
                      disabled={IS_WINDOWS}
                      onChange={(e) => setFido2GenResident(e.target.checked)}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500 disabled:opacity-40"
                    />
                    <span>
                      Resident (discoverable) — no file needed to authenticate later
                      {IS_WINDOWS && <span className="text-txt-muted"> (not available on Windows)</span>}
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-txt-primary">
                    <input
                      type="checkbox"
                      checked={fido2GenVerifyRequired}
                      onChange={(e) => setFido2GenVerifyRequired(e.target.checked)}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                    <span>Require PIN + touch on every use (recommended)</span>
                  </label>
                </div>

                <button
                  type="button"
                  onClick={() => void generateFido2Key()}
                  disabled={fido2Generating}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40 shadow-sm transition-colors"
                >
                  {fido2Generating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {fido2Generating ? 'Touch your security key...' : 'Generate Key'}
                </button>

                {fido2GenError && (
                  <div className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2">
                    <div className="flex items-center gap-1.5 text-red-300">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>{fido2GenError}</span>
                    </div>
                    {fido2GenNeedsOverwriteConfirm && (
                      <div className="flex items-center gap-2">
                        <span className="text-txt-muted">
                          If the on-device credential this pointed to was already deleted, the local
                          file is just a stale leftover — overwrite it?
                        </span>
                        <button
                          type="button"
                          onClick={() => void generateFido2Key(true)}
                          disabled={fido2Generating}
                          className="shrink-0 rounded-md border border-red-400/40 px-2 py-1 text-red-300 hover:bg-red-500/20 disabled:opacity-40 transition-colors"
                        >
                          Overwrite
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {fido2GenResult && (
                  <div className="flex flex-col gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2">
                    <div className="flex items-center gap-1.5 text-emerald-300">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span>Key generated at {fido2GenResult.privateKeyPath}</span>
                    </div>
                    <p className="text-xs text-txt-muted">
                      Copy the public key below into the server's{' '}
                      <code className="font-mono">~/.ssh/authorized_keys</code>:
                    </p>
                    <div className="flex items-start gap-1.5">
                      <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border-subtle bg-app-surface px-2 py-1 font-mono text-2xs text-txt-secondary">
                        {fido2GenResult.publicKey}
                      </code>
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(fido2GenResult.publicKey)}
                        className="shrink-0 rounded-md border border-border-subtle p-1.5 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                        title="Copy public key"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Outgoing Proxy Settings */}
      <div className="rounded-lg border border-border-subtle bg-app-surface-subtle p-2.5">
        <label className="flex items-center gap-2 text-txt-secondary font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(config.proxy)}
            onChange={(e) => {
              if (e.target.checked) {
                update('proxy', { type: 'socks5', host: '127.0.0.1', port: 1080 });
              } else {
                update('proxy', undefined);
              }
            }}
            className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
          />
          <span>Enable Outgoing Proxy (HTTP / SOCKS)</span>
        </label>

        {config.proxy && (
          <div className="mt-2.5 grid grid-cols-2 gap-2.5 pt-2 border-t border-divider">
            <label className="flex flex-col gap-1 text-txt-secondary">
              Proxy Type
              <select
                value={config.proxy.type}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    proxy: { ...prev.proxy!, type: e.target.value as any },
                  }))
                }
                className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500"
              >
                <option value="socks5">SOCKS5</option>
                <option value="socks4">SOCKS4</option>
                <option value="http">HTTP</option>
              </select>
            </label>

            <div className="grid grid-cols-[1fr_70px] gap-2">
              <label className="flex flex-col gap-1 text-txt-secondary">
                Proxy Host
                <input
                  value={config.proxy.host}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      proxy: { ...prev.proxy!, host: e.target.value },
                    }))
                  }
                  className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500"
                  placeholder="127.0.0.1"
                />
              </label>
              <label className="flex flex-col gap-1 text-txt-secondary">
                Port
                <input
                  type="number"
                  value={config.proxy.port}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      proxy: { ...prev.proxy!, port: Number(e.target.value) || 1080 },
                    }))
                  }
                  className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 text-center"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1 text-txt-secondary">
              Proxy Username (optional)
              <input
                value={config.proxy.username ?? ''}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    proxy: { ...prev.proxy!, username: e.target.value },
                  }))
                }
                className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500"
              />
            </label>

            <label className="flex flex-col gap-1 text-txt-secondary">
              Proxy Password (optional)
              <input
                type="password"
                value={config.proxy.password ?? ''}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    proxy: { ...prev.proxy!, password: e.target.value },
                  }))
                }
                disabled={!canEditSecret}
                placeholder={!canEditSecret ? '•••• (admin only)' : undefined}
                className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>
        )}
      </div>

      {/* Dotfiles Pool (opt-in, hidden unless enabled in Settings) */}
      {dotfilesPoolEnabled && (
        <div className="rounded-lg border border-border-subtle bg-app-surface-subtle p-2.5 space-y-2.5">
          <label className="flex flex-col gap-1 text-txt-secondary">
            Dotfiles Pool (optional)
            <select
              value={config.poolId ?? ''}
              onChange={(e) => {
                const poolId = e.target.value || undefined;
                update('poolId', poolId);
                if (!poolId) update('dotfilesSyncPolicy', undefined);
                else if (!config.dotfilesSyncPolicy) update('dotfilesSyncPolicy', 'ask');
              }}
              className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500"
            >
              <option value="">Not assigned — no sync</option>
              {dotfilePools.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.name} ({pool.files.length} file{pool.files.length === 1 ? '' : 's'})
                </option>
              ))}
            </select>
          </label>

          {config.poolId && (
            <label className="flex flex-col gap-1 text-txt-secondary">
              Sync Policy
              <select
                value={config.dotfilesSyncPolicy ?? 'ask'}
                onChange={(e) => update('dotfilesSyncPolicy', e.target.value as 'ask' | 'always')}
                className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500"
              >
                <option value="ask">Ask before updating (shows a diff banner on connect)</option>
                <option value="always">Always update silently on connect</option>
              </select>
            </label>
          )}
        </div>
      )}

      {/* Workspace AI, Cluster & Node Tagging */}
      <div className="rounded-lg border border-border-subtle bg-app-surface-subtle p-3 space-y-2.5">
        <div className="text-xs font-semibold text-txt-primary">
          Workspace AI, Cluster &amp; Node Tagging (shared with team &amp; AI memory)
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <label className="flex flex-col gap-1 text-txt-secondary">
            <span>Cluster (optional)</span>
            <input
              value={config.cluster ?? ''}
              onChange={(e) => update('cluster', e.target.value || undefined)}
              placeholder="e.g. k8s-eu-north-1"
              className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            />
          </label>
          <label className="flex flex-col gap-1 text-txt-secondary">
            <span>Node Role</span>
            <select
              value={config.nodeRole ?? ''}
              onChange={(e) => update('nodeRole', e.target.value || undefined)}
              className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500"
            >
              <option value="">None</option>
              <option value="control-plane">Control Plane / Master</option>
              <option value="worker-node">Worker Node</option>
              <option value="gpu-node">GPU / AI Node</option>
              <option value="ingress">Ingress / Edge Proxy</option>
              <option value="primary-db">Primary Database</option>
              <option value="replica-db">Replica / Read Node</option>
              <option value="storage-node">Storage / NVMe Node</option>
              <option value="bastion">Bastion / Jump Node</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-txt-secondary">
            <span>Tags (comma-separated)</span>
            <input
              value={(config.tags ?? []).join(', ')}
              onChange={(e) => {
                const tags = e.target.value
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean);
                update('tags', tags.length > 0 ? tags : undefined);
              }}
              placeholder="k8s, gpu-node, prod"
              className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-txt-secondary">
          <span>What does this VM / node do? (AI &amp; Team Description)</span>
          <input
            value={config.description ?? ''}
            onChange={(e) => update('description', e.target.value || undefined)}
            placeholder="e.g. Primary Kubernetes worker running inference pods on port 8080"
            className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
          />
        </label>
      </div>

      {/* Advanced SSH Options */}
      <div className="rounded-lg border border-border-subtle bg-app-surface-subtle">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          className="flex w-full items-center justify-between p-2.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          <span>Advanced SSH Options (Agent Forwarding, Compression, KeepAlive, Ciphers, KEX, MACs)</span>
          {advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {advancedOpen && (
          <div className="border-t border-divider p-3 space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-txt-primary">
                <input
                  type="checkbox"
                  checked={config.forwardAgent ?? false}
                  onChange={(e) => update('forwardAgent', e.target.checked)}
                  className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                />
                <span>Forward SSH Agent (-A)</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-txt-primary">
                <input
                  type="checkbox"
                  checked={config.compression ?? false}
                  onChange={(e) => update('compression', e.target.checked)}
                  className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                />
                <span>Enable Compression</span>
              </label>

              {config.forwardAgent && (
                <div className="col-span-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-2xs text-amber-300 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
                  <div>
                    <span className="font-semibold block">Security Advisory: SSH Agent Forwarding</span>
                    Agent forwarding allows anyone with root/administrator access on the remote server to access your local SSH keys while the session is active. Only enable this on servers you completely trust.
                  </div>
                </div>
              )}


              <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-txt-primary col-span-2">
                <input
                  type="checkbox"
                  checked={config.x11Forwarding ?? false}
                  onChange={(e) => update('x11Forwarding', e.target.checked)}
                  className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                />
                <span>Forward X11 GUI (-Y)</span>
              </label>
            </div>

            {config.x11Forwarding && (
              <div className="rounded-lg border border-border-subtle bg-app-surface/50 p-2.5 space-y-2">
                <label className="flex flex-col gap-1 text-txt-secondary">
                  <span>X11 Display Location (default: 127.0.0.1:0.0 or :0)</span>
                  <input
                    value={config.x11Display ?? ''}
                    onChange={(e) => update('x11Display', e.target.value)}
                    className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                    placeholder="127.0.0.1:0.0"
                  />
                </label>
                {x11ServerStatus && (
                  <div className="flex items-center gap-1.5 text-xs">
                    {x11ServerStatus.running ? (
                      <span className="text-emerald-400">
                        ✓ Local X11 server detected on {x11ServerStatus.display}
                      </span>
                    ) : (
                      <span className="text-amber-400">
                        {x11ServerStatus.platform === 'linux'
                          ? `⚠ No local X11 server listening on ${x11ServerStatus.display}. Ensure an X11 or Xwayland session is active.`
                          : `⚠ No local X11 server listening on ${x11ServerStatus.display}. Start an X server (e.g. VcXsrv, Xming, or WSLg) on Windows.`}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-txt-secondary">
                ServerAliveInterval (sec)
                <input
                  type="number"
                  min={0}
                  max={3600}
                  value={config.serverAliveInterval ?? 60}
                  onChange={(e) => update('serverAliveInterval', parseInt(e.target.value, 10) || 0)}
                  className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                />
              </label>
            </div>

            <div className="space-y-2">
              <label className="flex flex-col gap-1 text-txt-secondary">
                Custom Ciphers (comma-separated, empty = defaults)
                <input
                  value={config.ciphers ?? ''}
                  onChange={(e) => update('ciphers', e.target.value)}
                  className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                  placeholder="chacha20-poly1305@openssh.com,aes128-gcm@openssh.com"
                />
              </label>

              <label className="flex flex-col gap-1 text-txt-secondary">
                Custom KEX Algorithms (comma-separated, empty = defaults)
                <input
                  value={config.kexAlgorithms ?? ''}
                  onChange={(e) => update('kexAlgorithms', e.target.value)}
                  className="rounded-lg border border-border-subtle bg-app-input px-2.5 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                  placeholder="curve25519-sha256,ecdh-sha2-nistp256"
                />
              </label>

              <label className="flex flex-col gap-1 text-txt-secondary">
                Custom MACs (comma-separated, empty = defaults)
                <input
                  value={config.macs ?? ''}
                  onChange={(e) => update('macs', e.target.value)}
                  placeholder="e.g. hmac-sha2-256,hmac-sha1"
                  className="rounded-lg border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                />
              </label>
            </div>
          </div>
        )}
      </div>

      <AccessSetupPanel
        config={config}
        resetKey={accessResetKey}
        onStateChange={setAccessState}
        openInstallSignal={openInstallSignal}
      />

      </div>

      <div className="shrink-0 flex items-center justify-between gap-2 border-t border-divider bg-app-card px-4 py-3">
        <div className="min-w-0 text-xs text-txt-muted">
          {accessState === 'verified' && <span className="text-emerald-300">Login verified</span>}
          {accessState === 'installed' && <span className="text-emerald-300">Key installed</span>}
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!isValid}
            title={isValid ? undefined : 'Fill in profile name, hostname and username first'}
            className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40 shadow-sm transition-colors"
          >
            Save Profile
          </button>
        </div>
      </div>
      {saveReminderOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-reminder-title"
          data-testid="save-reminder-dialog"
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/65 p-4"
        >
          <div className="w-full max-w-sm space-y-3 rounded-xl border border-border-subtle bg-app-card p-5 shadow-2xl">
            <h2 id="save-reminder-title" className="text-sm font-semibold text-txt-primary">
              Not verified on the host yet
            </h2>
            <p className="text-xs text-txt-secondary">
              This profile uses key-based login, and nothing has confirmed that the host accepts it. You can install your
              key now, or save the profile and do it later from the profile list.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setSaveReminderOpen(false);
                  onSave(config);
                }}
                className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary"
              >
                Save anyway
              </button>
              <button
                type="button"
                onClick={() => {
                  setSaveReminderOpen(false);
                  setOpenInstallSignal((n) => n + 1);
                }}
                className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
              >
                Set up access
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
};

export default SSHProfileForm;
