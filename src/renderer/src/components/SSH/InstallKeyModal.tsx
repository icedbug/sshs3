import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  Check,
  CheckCircle2,
  Clipboard,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import type {
  InstallLoginMethod,
  InstallPublicKeysResult,
  LocalPublicKey,
  SSHConnectionConfig,
} from '@shared/types/ssh';
import { classNames, describeIpcError } from '../../lib/format';
import { chooseLoginOrder, LOGIN_STEP_LABELS } from '@shared/loginOrder';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { isFeatureBlocked, usePolicy } from '../../lib/usePolicy';
import { FeatureBlockedNotice } from '../SettingsModal/Managed';

interface InstallKeyModalProps {
  /** Profilen att installera nycklar på; får vara osparad. */
  connection: SSHConnectionConfig;
  onClose: () => void;
  /** Auth-metoder servern annonserade vid en tidigare probe, om kända. */
  serverMethods?: string[];
  onInstalled?: (result: InstallPublicKeysResult) => void;
}

const SOURCE_LABEL: Record<LocalPublicKey['source'], string> = {
  file: 'File',
  agent: 'Already loaded',
  fido2: 'FIDO2',
  smartcard: 'Smartcard',
  manual: 'Pasted',
  github: 'GitHub',
  gitlab: 'GitLab',
  'git-custom': 'Git',
};

const STATUS_TEXT: Record<string, string> = {
  installed: 'Installed',
  present: 'Already present',
  invalid: 'Invalid key',
  unknown: 'Not confirmed',
};

/** Builds a row for a manually pasted key line; the backend re-validates it before use. */
function manualKey(line: string): LocalPublicKey {
  const trimmed = line.trim();
  const [type = 'key', , ...comment] = trimmed.split(' ');
  return {
    id: `manual:${trimmed}`,
    line: trimmed,
    type,
    fingerprint: '',
    comment: comment.join(' '),
    source: 'manual',
    label: comment.join(' ') || 'Pasted key',
  };
}

export const InstallKeyModal: React.FC<InstallKeyModalProps> = ({ connection, onClose, serverMethods, onInstalled }) => {
  const [keys, setKeys] = useState<LocalPublicKey[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingHardware, setLoadingHardware] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ keys: LocalPublicKey[]; outcome: InstallPublicKeysResult } | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedPowerShell, setCopiedPowerShell] = useState(false);
  const [loginMethod, setLoginMethod] = useState<InstallLoginMethod>('auto');

  // Git public key import state
  const [gitProvider, setGitProvider] = useState<'github' | 'gitlab' | 'custom'>('github');
  const gitKeyFetchBlocked = isFeatureBlocked(usePolicy(), 'gitKeyFetch');
  const [gitUsername, setGitUsername] = useState('');
  const [gitCustomHost, setGitCustomHost] = useState('');
  const [fetchingGit, setFetchingGit] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  const busy = installing || loadingHardware || fetchingGit;
  const handleBackdrop = useModalDismiss(onClose, true, !busy);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true);
  const hasHardware =
    (connection.authType === 'smartcard' && !!connection.pkcs11LibPath) ||
    (connection.authType === 'fido2' && !!connection.fido2Resident);
  // Hide the "read from device" button once the keys are already listed (e.g. from the unlocked cache).
  const hardwareLoaded = keys.some((k) => k.source === 'smartcard' || k.source === 'fido2');

  useEffect(() => {
    let cancelled = false;
    window.multissh
      .listPublicKeys({ config: connection })
      .then((list) => {
        if (cancelled) return;
        setKeys(list);
        // Pre-select only the key that belongs to this profile's own key file; everything else is opt-in.
        // Keys from the profile's own card/security key (read from the unlocked cache) count as "its own" too.
        const own = list.filter(
          (k) =>
            (connection.privateKeyPath && k.privateKeyPath === connection.privateKeyPath) ||
            k.source === 'smartcard' ||
            k.source === 'fido2'
        );
        setSelected(new Set(own.map((k) => k.id)));
      })
      .catch((err) => !cancelled && setError(describeIpcError(err, 'Failed to list public keys')))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [connection.id, connection.privateKeyPath]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Är nyckeln den som profilen själv loggar in med? (Då är det poänglöst att logga in med den för att installera den.) */
  const isOwnKey = useCallback(
    (k: LocalPublicKey): boolean =>
      (!!connection.privateKeyPath && k.privateKeyPath === connection.privateKeyPath) ||
      (connection.authType === 'smartcard' && k.source === 'smartcard') ||
      (connection.authType === 'fido2' && k.source === 'fido2'),
    [connection.authType, connection.privateKeyPath]
  );

  // The same rule the backend applies, shown so the order is never a surprise (e.g. a PIN prompt).
  const hasOtherSmartcard = connection.authType !== 'smartcard' && !!connection.pkcs11LibPath?.trim();

  const selectedKeys = useMemo(() => keys.filter((k) => selected.has(k.id)), [keys, selected]);

  const allSelected = keys.length > 0 && keys.every((k) => selected.has(k.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(keys.map((k) => k.id)));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const loadHardware = useCallback(async () => {
    setLoadingHardware(true);
    setError(null);
    try {
      const list = await window.multissh.listPublicKeys({ config: connection, includeHardware: true });
      const fromDevice = list.filter((k) => k.source === 'smartcard' || k.source === 'fido2');
      if (fromDevice.length === 0) {
        setError(
          connection.authType === 'fido2'
            ? 'No resident SSH credentials were found on the security key. If your key was created as a key file (id_*_sk), it is already listed above: the file holds its public key, and the security key only signs.'
            : 'No keys were found on the card.'
        );
      }
      setKeys((prev) => {
        const known = new Set(prev.map((k) => k.id));
        return [...prev, ...list.filter((k) => !known.has(k.id))];
      });
      // Keys the user just asked to read from the device are pre-selected.
      setSelected((prev) => new Set([...prev, ...fromDevice.map((k) => k.id)]));
    } catch (err) {
      setError(describeIpcError(err, 'Failed to read keys from the device'));
    } finally {
      setLoadingHardware(false);
    }
  }, [connection]);

  const addPasted = () => {
    const lines = pasteValue
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    const rows = lines.map(manualKey);
    setKeys((prev) => [...prev, ...rows.filter((r) => !prev.some((k) => k.id === r.id))]);
    setSelected((prev) => new Set([...prev, ...rows.map((r) => r.id)]));
    setPasteValue('');
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    setResult(null);
    const toInstall = selectedKeys;
    try {
      const outcome = await window.multissh.installPublicKeys({
        config: connection,
        publicKeys: toInstall.map((k) => k.line),
        loginMethod,
        installsOwnKeyOnly: toInstall.length > 0 && toInstall.every(isOwnKey),
        serverMethods,
      });
      setResult({ keys: toInstall, outcome });
      onInstalled?.(outcome);
      if (!outcome.success && outcome.error) setError(outcome.error);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to install the key'));
    } finally {
      setInstalling(false);
    }
  };

  const refreshCommand = useCallback(
    async (lines: string[], copy: boolean) => {
      if (lines.length === 0) {
        setCommand(null);
        return;
      }
      try {
        const cmd = await window.multissh.buildInstallCommand(lines);
        setCommand(cmd);
        if (copy) {
          await navigator.clipboard.writeText(cmd);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }
      } catch (err) {
        setError(describeIpcError(err, 'Failed to build the command'));
      }
    },
    []
  );

  const copyCommand = () => {
    setError(null);
    void refreshCommand(selectedKeys.map((k) => k.line), true);
  };

  const copyPowerShellCommand = async () => {
    if (selectedKeys.length === 0) return;
    setError(null);
    try {
      const keysContent = selectedKeys.map((k) => k.line.trim()).join('\r\n');
      const ps = `if (!(Test-Path $HOME\\.ssh)) { New-Item -ItemType Directory -Path $HOME\\.ssh }; @'\r\n${keysContent}\r\n'@ | Out-File -Append -Encoding ascii -FilePath $HOME\\.ssh\\authorized_keys`;
      await navigator.clipboard.writeText(ps);
      setCopiedPowerShell(true);
      setTimeout(() => setCopiedPowerShell(false), 2000);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to copy PowerShell command'));
    }
  };

  const copyKeyOnly = async (key: LocalPublicKey) => {
    try {
      await navigator.clipboard.writeText(key.line);
      setCopiedKeyId(key.id);
      setTimeout(() => {
        setCopiedKeyId((current) => (current === key.id ? null : current));
      }, 3000);
    } catch {
      setError('Failed to copy key to clipboard');
    }
  };

  const fetchGitKeys = async () => {
    if (gitKeyFetchBlocked) return;
    const user = gitUsername.trim();
    if (!user) return;
    setFetchingGit(true);
    setError(null);
    try {
      const res = await window.multissh.gitFetchPublicKeys({
        provider: gitProvider,
        username: user,
        customHost: gitCustomHost.trim() || undefined,
      });
      if (!res.success) {
        setError(res.error || 'Failed to fetch public keys');
      } else if (res.keys.length === 0) {
        setError(`No public keys found for '${user}' on ${gitProvider}.`);
      } else {
        setKeys((prev) => {
          const known = new Set(prev.map((k) => k.id));
          return [...prev, ...res.keys.filter((k) => !known.has(k.id))];
        });
        setSelected((prev) => new Set([...prev, ...res.keys.map((k) => k.id)]));
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to fetch keys from Git provider'));
    } finally {
      setFetchingGit(false);
    }
  };

  // Once the command is shown, keep it (and the clipboard) in sync with the selection.
  const selectionSignature = selectedKeys.map((k) => k.line).join('\n');
  useEffect(() => {
    if (command === null) return;
    void refreshCommand(selectionSignature ? selectionSignature.split('\n') : [], selectionSignature !== '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionSignature]);

  const loginOrder = useMemo(
    () =>
      chooseLoginOrder({
        authType: connection.authType,
        loginMethod: 'auto',
        installsOwnKeyOnly: selectedKeys.length > 0 && selectedKeys.every(isOwnKey),
        serverMethods,
        hasSmartcardLib: !!connection.pkcs11LibPath?.trim(),
      }),
    [connection.authType, connection.pkcs11LibPath, selectedKeys, isOwnKey, serverMethods]
  );

  // Done once every key in the last run went in and the selection is still the same one.
  const done =
    !!result &&
    result.outcome.success &&
    result.keys.length === selectedKeys.length &&
    result.keys.every((k) => selected.has(k.id));

  const hostLabel = `${connection.username ? `${connection.username}@` : ''}${connection.host}`;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-key-title"
      data-testid="install-key-modal"
      onClick={handleBackdrop}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border-subtle bg-app-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-5 py-3.5">
          <div className="flex items-center gap-3">
            <KeyRound className="h-4 w-4 text-sky-400" />
            <div>
              <h2 id="install-key-title" className="text-sm font-semibold text-txt-primary">
                Install public key
              </h2>
              <p className="text-xs text-txt-muted">{hostLabel}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1.5 text-txt-muted transition-colors hover:bg-app-surface-hover hover:text-txt-primary disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5 text-xs text-txt-secondary">
          <p>
            Adds the selected keys to <code>~/.ssh/authorized_keys</code> on the host, like <code>ssh-copy-id</code>. The
            profile&apos;s own login is used first (including its jump host); if it is rejected, OpenSSH falls back to
            password and you are prompted for it.
          </p>

          {keys.length > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-txt-muted">
                {selected.size} of {keys.length} selected
              </span>
              <button
                type="button"
                onClick={toggleAll}
                disabled={installing}
                className="rounded-lg border border-border-subtle px-2.5 py-1 text-txt-primary transition-colors hover:bg-app-surface-hover disabled:opacity-50"
              >
                {allSelected ? 'Clear selection' : 'Select all'}
              </button>
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-txt-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking for keys…
            </div>
          ) : (
            <div className="divide-y divide-divider overflow-hidden rounded-xl border border-border-subtle bg-app-surface">
              {keys.length === 0 && <div className="p-3 text-txt-muted">No public keys found. Paste one below.</div>}
              {keys.map((k) => (
                <label key={k.id} className="flex cursor-pointer items-start gap-3 p-3 hover:bg-app-surface-hover">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.has(k.id)}
                    disabled={installing}
                    onChange={() => toggle(k.id)}
                    aria-label={`Select ${k.label}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-txt-primary">{k.label}</span>
                      <span
                        title={k.source === 'agent' ? 'Already unlocked and cached on this computer, so no PIN or password is needed to read it' : undefined}
                        className="rounded bg-app-card px-1.5 py-0.5 text-2xs uppercase text-txt-muted"
                      >
                        {SOURCE_LABEL[k.source]}
                      </span>
                    </div>
                    <div className="truncate font-mono text-2xs text-txt-muted">
                      {k.type}
                      {k.fingerprint ? ` · ${k.fingerprint}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 self-center">
                    <button
                      type="button"
                      title="Copy public key to clipboard"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void copyKeyOnly(k);
                      }}
                      className={classNames(
                        'flex items-center gap-1 text-2xs rounded px-2 py-1 transition-colors border',
                        copiedKeyId === k.id
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400 font-medium'
                          : 'text-txt-muted hover:text-txt-primary bg-app-card hover:bg-app-surface border-border-subtle'
                      )}
                    >
                      {copiedKeyId === k.id ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>
                </label>
              ))}
            </div>
          )}

          {hasHardware && !hardwareLoaded && (
            <button
              type="button"
              onClick={() => void loadHardware()}
              disabled={busy}
              className="rounded-lg border border-border-subtle px-3 py-1.5 text-txt-primary transition-colors hover:bg-app-surface-hover disabled:opacity-50"
            >
              {loadingHardware
                ? 'Reading…'
                : connection.authType === 'smartcard'
                  ? 'Read keys from smartcard (PIN)'
                  : 'Read keys from security key (PIN / touch)'}
            </button>
          )}

          <div className="space-y-2 rounded-xl border border-border-subtle bg-app-surface p-3">
            <div className="flex items-center justify-between">
              <span className="font-medium text-txt-primary flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5 text-sky-400" /> Fetch from Git Provider (username.keys)
              </span>
              <div className="flex items-center gap-1 bg-app-card rounded-lg p-0.5 border border-border-subtle text-2xs">
                <button
                  type="button"
                  onClick={() => setGitProvider('github')}
                  className={classNames(
                    'px-2 py-0.5 rounded transition-colors',
                    gitProvider === 'github' ? 'bg-sky-600 text-white font-medium' : 'text-txt-muted hover:text-txt-primary'
                  )}
                >
                  GitHub
                </button>
                <button
                  type="button"
                  onClick={() => setGitProvider('gitlab')}
                  className={classNames(
                    'px-2 py-0.5 rounded transition-colors',
                    gitProvider === 'gitlab' ? 'bg-sky-600 text-white font-medium' : 'text-txt-muted hover:text-txt-primary'
                  )}
                >
                  GitLab
                </button>
                <button
                  type="button"
                  onClick={() => setGitProvider('custom')}
                  className={classNames(
                    'px-2 py-0.5 rounded transition-colors',
                    gitProvider === 'custom' ? 'bg-sky-600 text-white font-medium' : 'text-txt-muted hover:text-txt-primary'
                  )}
                >
                  Custom
                </button>
              </div>
            </div>
            <div className="flex gap-2 items-center">
              {gitProvider === 'custom' && (
                <input
                  aria-label="Custom Git host"
                  type="text"
                  value={gitCustomHost}
                  onChange={(e) => setGitCustomHost(e.target.value)}
                  placeholder="git.example.com"
                  className="w-40 rounded-lg border border-border-subtle bg-app-card px-2.5 py-1 text-2xs text-txt-primary"
                />
              )}
              <input
                aria-label={gitProvider === 'github' ? 'GitHub username' : 'GitLab username'}
                type="text"
                value={gitUsername}
                onChange={(e) => setGitUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void fetchGitKeys()}
                placeholder={gitProvider === 'github' ? 'GitHub username (e.g. torvalds)' : 'GitLab username'}
                className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-app-card px-2.5 py-1 text-2xs text-txt-primary"
              />
              <button
                type="button"
                onClick={() => void fetchGitKeys()}
                disabled={!gitUsername.trim() || fetchingGit || busy || gitKeyFetchBlocked}
                aria-describedby={gitKeyFetchBlocked ? 'install-git-key-fetch-blocked' : undefined}
                className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1 text-xs text-txt-primary transition-colors hover:bg-app-surface-hover disabled:opacity-50"
              >
                {fetchingGit && <Loader2 className="h-3 w-3 animate-spin" />}
                Fetch keys
              </button>
            </div>
            <FeatureBlockedNotice blocked={gitKeyFetchBlocked} id="install-git-key-fetch-blocked" />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="install-key-paste" className="text-txt-muted">
              Paste a public key
            </label>
            <div className="flex gap-2">
              <textarea
                id="install-key-paste"
                rows={2}
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
                placeholder="ssh-ed25519 AAAA… comment"
                className="min-w-0 flex-1 resize-none rounded-lg border border-border-subtle bg-app-surface p-2 font-mono text-2xs text-txt-primary"
              />
              <button
                type="button"
                onClick={addPasted}
                disabled={!pasteValue.trim() || installing}
                className="self-start rounded-lg border border-border-subtle px-3 py-1.5 text-txt-primary transition-colors hover:bg-app-surface-hover disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </div>

          {connection.authType !== 'password' && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <label htmlFor="install-key-login" className="text-txt-muted">
                  Log in with
                </label>
                <select
                  id="install-key-login"
                  value={loginMethod}
                  disabled={installing}
                  onChange={(e) => setLoginMethod(e.target.value as InstallLoginMethod)}
                  className="rounded-lg border border-border-subtle bg-app-surface px-2 py-1 text-txt-primary"
                >
                  <option value="auto">Automatic (recommended)</option>
                  <option value="password">Password</option>
                  <option value="profile">This profile&apos;s key</option>
                  {hasOtherSmartcard && <option value="smartcard">{LOGIN_STEP_LABELS.smartcard}</option>}
                  <option value="agent">{LOGIN_STEP_LABELS.agent}</option>
                </select>
              </div>
              {loginMethod === 'auto' && loginOrder.length === 0 && (
                <div data-testid="install-key-login-order" className="text-2xs text-amber-300">
                  No automatic login is possible: the host only accepts keys, and the only key selected is the one this
                  profile logs in with. Select another key, pick a login method above, or copy the command.
                </div>
              )}
              {loginMethod === 'auto' && loginOrder.length > 0 && (
                <div data-testid="install-key-login-order" className="text-2xs text-txt-muted">
                  Tries, in order: {loginOrder.map((step) => LOGIN_STEP_LABELS[step]).join(' → ')}
                </div>
              )}
            </div>
          )}

          {result && (
            <div data-testid="install-key-result" className="space-y-1.5 rounded-xl border border-border-subtle bg-app-surface p-3">
              {result.outcome.loginMethod && (
                <div className="text-txt-muted">
                  Logged in with {LOGIN_STEP_LABELS[result.outcome.loginMethod].replace(/^[A-Z]/, (c) => c.toLowerCase())}.
                </div>
              )}
              {result.keys.map((k, i) => {
                const r = result.outcome.results[i];
                const ok = r?.status === 'installed' || r?.status === 'present';
                return (
                  <div key={k.id} className="flex items-center gap-2">
                    {ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                    )}
                    <span className="truncate text-txt-primary">{k.label}</span>
                    <span className="text-txt-muted">{STATUS_TEXT[r?.status ?? 'unknown']}</span>
                    {r?.verified === true && <span className="text-emerald-400">key login works</span>}
                    {r?.verified === false && <span className="text-amber-400">key login failed</span>}
                  </div>
                );
              })}
            </div>
          )}

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-300">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {command && (
            <div className="space-y-1.5">
              <div className="text-txt-muted">Paste this on the host if it can&apos;t be reached from here. It only creates ~/.ssh/authorized_keys if needed and appends the selected keys:</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border-subtle bg-app-surface p-2 font-mono text-2xs text-txt-primary">
                {command}
              </pre>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-divider bg-app-surface px-5 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyCommand}
              disabled={selectedKeys.length === 0 || busy}
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-txt-primary transition-colors hover:bg-app-surface-hover disabled:opacity-50"
            >
              <Clipboard className="h-3.5 w-3.5" />
              {copied ? 'Copied Bash' : 'Copy command (Bash)'}
            </button>
            <button
              type="button"
              onClick={() => void copyPowerShellCommand()}
              disabled={selectedKeys.length === 0 || busy}
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-txt-primary transition-colors hover:bg-app-surface-hover disabled:opacity-50"
            >
              <Clipboard className="h-3.5 w-3.5" />
              {copiedPowerShell ? 'Copied PowerShell' : 'Copy PowerShell'}
            </button>
          </div>
          <div className="flex gap-2">
            {done ? (
              // Everything selected is installed: the way forward is "Done", not "Close"/"Install again".
              <button
                type="button"
                onClick={onClose}
                autoFocus
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-500"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Done
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={busy}
                  className="rounded-lg px-3 py-1.5 text-xs text-txt-secondary transition-colors hover:bg-app-surface-hover disabled:opacity-50"
                >
                  {result ? 'Close' : 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={() => void install()}
                  disabled={selectedKeys.length === 0 || busy}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {installing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {installing
                    ? 'Installing…'
                    : `${result && !result.outcome.success ? 'Try again' : 'Install'} ${selectedKeys.length || ''} key${selectedKeys.length === 1 ? '' : 's'}`.replace('  ', ' ')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
