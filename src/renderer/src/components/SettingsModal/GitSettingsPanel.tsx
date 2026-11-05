import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Globe,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { LocalPublicKey } from '@shared/types/ssh';
import type { GitSigningConfig } from '@shared/types/git';
import { classNames, describeIpcError } from '../../lib/format';
import { isFeatureBlocked, usePolicy } from '../../lib/usePolicy';
import { FeatureBlockedNotice } from './Managed';

const SOURCE_LABEL: Record<string, string> = {
  file: 'File',
  agent: 'Loaded in agent',
  fido2: 'FIDO2',
  smartcard: 'Smartcard',
  manual: 'Pasted',
  github: 'GitHub',
  gitlab: 'GitLab',
  'git-custom': 'Git',
};

interface KeyNotice {
  title: string;
  description?: string;
  keySnippet?: string;
}

export interface GitSettingsPanelProps {
  fileManagerGitIntegration?: boolean;
  onChangeFileManagerGitIntegration?: (enabled: boolean) => void;
}

export const GitSettingsPanel: React.FC<GitSettingsPanelProps> = ({
  fileManagerGitIntegration = true,
  onChangeFileManagerGitIntegration,
}) => {
  const [keys, setKeys] = useState<LocalPublicKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [signingConfig, setSigningConfig] = useState<GitSigningConfig | null>(null);
  const [loadingSigning, setLoadingSigning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<KeyNotice | null>(null);

  // Button state tracking
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [copiedAction, setCopiedAction] = useState<'copy' | 'github' | 'gitlab' | null>(null);
  const [signingConfiguringId, setSigningConfiguringId] = useState<string | null>(null);

  // Custom signing key input state
  const [showCustomSigningKey, setShowCustomSigningKey] = useState(false);
  const [customKeyText, setCustomKeyText] = useState('');
  const [savingCustomKey, setSavingCustomKey] = useState(false);
  const [togglingSigning, setTogglingSigning] = useState(false);

  // Fetch from Git Provider state
  const [gitProvider, setGitProvider] = useState<'github' | 'gitlab' | 'custom'>('github');
  const [gitUsername, setGitUsername] = useState('');
  const [gitCustomHost, setGitCustomHost] = useState('');
  const [fetchingGit, setFetchingGit] = useState(false);
  const gitKeyFetchBlocked = isFeatureBlocked(usePolicy(), 'gitKeyFetch');
  const [fetchedKeys, setFetchedKeys] = useState<LocalPublicKey[]>([]);

  const loadSigningConfig = useCallback(async (): Promise<GitSigningConfig | null> => {
    setLoadingSigning(true);
    try {
      const cfg = await window.multissh.gitGetSigningConfig();
      setSigningConfig(cfg);
      return cfg;
    } catch {
      return null;
    } finally {
      setLoadingSigning(false);
    }
  }, []);

  const loadKeys = useCallback(async (currentSigningConfig?: GitSigningConfig | null) => {
    setLoadingKeys(true);
    try {
      const list = await window.multissh.listPublicKeys({
        includeHardware: true,
      });

      // If ~/.gitconfig has a signing key that starts with ssh-/ecdsa-/sk-, ensure it is in the list
      const activeKeyStr = currentSigningConfig?.signingKey?.trim() || signingConfig?.signingKey?.trim();
      if (activeKeyStr && (activeKeyStr.startsWith('ssh-') || activeKeyStr.startsWith('ecdsa-') || activeKeyStr.startsWith('sk-'))) {
        const already = list.some((k) => k.line.trim() === activeKeyStr || activeKeyStr.startsWith(k.line.trim()));
        if (!already) {
          const parts = activeKeyStr.split(/\s+/);
          const comment = parts.slice(2).join(' ') || 'Git Signing Key';
          list.unshift({
            id: `gitconfig-${activeKeyStr.slice(0, 32)}`,
            line: activeKeyStr,
            type: parts[0] || 'ssh-rsa',
            fingerprint: 'Configured in ~/.gitconfig',
            comment,
            source: 'manual',
            label: comment.includes('PIV') || comment.includes('Smartcard') ? comment : `Configured Key (${comment})`,
          });
        }
      }

      setKeys(list);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to list local public keys'));
    } finally {
      setLoadingKeys(false);
    }
  }, [signingConfig?.signingKey]);

  useEffect(() => {
    void (async () => {
      const cfg = await loadSigningConfig();
      await loadKeys(cfg);
    })();
  }, [loadKeys, loadSigningConfig]);

  const copyKeyOnly = async (key: LocalPublicKey) => {
    try {
      await navigator.clipboard.writeText(key.line);
      setCopiedKeyId(key.id);
      setCopiedAction('copy');
      setTimeout(() => {
        setCopiedKeyId((current) => (current === key.id ? null : current));
        setCopiedAction(null);
      }, 3000);
      setNotice({
        title: 'Public key copied to clipboard!',
        description: `The public key for "${key.label}" is now in your clipboard and ready to paste (Ctrl+V / Cmd+V).`,
        keySnippet: key.line.length > 65 ? `${key.line.slice(0, 60)}…` : key.line,
      });
    } catch {
      setError('Failed to copy public key to clipboard');
    }
  };

  const registerOnGitProvider = async (key: LocalPublicKey, provider: 'github' | 'gitlab') => {
    try {
      await navigator.clipboard.writeText(key.line);
      setCopiedKeyId(key.id);
      setCopiedAction(provider);
      setTimeout(() => {
        setCopiedKeyId((current) => (current === key.id ? null : current));
        setCopiedAction(null);
      }, 4000);

      const url =
        provider === 'github'
          ? `https://github.com/settings/ssh/new?title=${encodeURIComponent(key.label || 'sshs3-key')}`
          : 'https://gitlab.com/-/user_settings/ssh_keys';
      void window.multissh.openExternal(url);

      setNotice({
        title: `Public key copied to clipboard!`,
        description: `${provider === 'github' ? 'GitHub' : 'GitLab'} does not allow pre-filling key content via web links for security reasons (CSRF mitigation). Your browser has been opened — paste the key (Ctrl+V or Cmd+V) into the "Key" field.`,
        keySnippet: key.line.length > 65 ? `${key.line.slice(0, 60)}…` : key.line,
      });
    } catch {
      setError('Failed to copy public key to clipboard');
    }
  };

  const configureSigning = async (keyOrLine: LocalPublicKey | string) => {
    const isObj = typeof keyOrLine !== 'string';
    const keyLine = isObj ? keyOrLine.line.trim() : keyOrLine.trim();
    const keyLabel = isObj ? keyOrLine.label : 'custom key';
    const keyId = isObj ? keyOrLine.id : 'custom';

    setSigningConfiguringId(keyId);
    setError(null);
    try {
      const res = await window.multissh.gitConfigureSigning({ signingKey: keyLine });
      if (res.success) {
        setShowCustomSigningKey(false);
        setCustomKeyText('');
        const updated = await loadSigningConfig();
        await loadKeys(updated);
        setNotice({
          title: 'Git commit signing configured!',
          description: `Git (~/.gitconfig) has been configured to sign commits with key "${keyLabel}". Automatic signing (commit.gpgsign) is now enabled.`,
        });
      } else {
        setError(res.error || 'Failed to configure Git signing');
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to configure Git signing'));
    } finally {
      setSigningConfiguringId(null);
    }
  };

  const toggleSigningEnabled = async () => {
    setTogglingSigning(true);
    setError(null);
    try {
      const nextState = !signingConfig?.enabled;
      const res = await window.multissh.gitSetSigningEnabled(nextState);
      if (res.success) {
        const updated = await loadSigningConfig();
        await loadKeys(updated);
        setNotice({
          title: nextState ? 'Git automatic signing enabled!' : 'Git automatic signing disabled',
          description: nextState
            ? 'Git will now automatically sign all commits with your configured SSH key (commit.gpgsign = true).'
            : 'Automatic commit signing has been turned off (commit.gpgsign = false).',
        });
      } else {
        setError(res.error || 'Failed to update signing state');
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to update signing state'));
    } finally {
      setTogglingSigning(false);
    }
  };

  const handleApplyCustomSigningKey = async () => {
    const key = customKeyText.trim();
    if (!key) return;
    setSavingCustomKey(true);
    try {
      await configureSigning(key);
    } finally {
      setSavingCustomKey(false);
    }
  };

  const fetchGitKeys = async () => {
    const user = gitUsername.trim();
    if (!user || gitKeyFetchBlocked) return;
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
      } else {
        setFetchedKeys(res.keys);
        setNotice({
          title: `Fetched ${res.keys.length} key(s) for '${user}'.`,
        });
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to fetch keys from Git provider'));
    } finally {
      setFetchingGit(false);
    }
  };

  // Determine if a key is the active signing key
  const isKeyActiveSigning = (key: LocalPublicKey): boolean => {
    if (!signingConfig?.signingKey) return false;
    const cleanConfigured = signingConfig.signingKey.trim();
    const cleanLine = key.line.trim();
    return (
      cleanConfigured === cleanLine ||
      cleanLine.includes(cleanConfigured) ||
      cleanConfigured.includes(key.fingerprint) ||
      (!!key.privateKeyPath && cleanConfigured === key.privateKeyPath)
    );
  };

  return (
    <div className="space-y-6 text-xs text-txt-secondary">
      {/* Top Banner Notice */}
      {notice && (
        <div
          data-testid="git-notice-banner"
          className="rounded-xl border border-sky-500/40 bg-sky-950/60 p-3.5 text-xs text-sky-200 flex items-start gap-3 shadow-md animate-in fade-in duration-150"
        >
          <Info className="h-4 w-4 text-sky-400 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1">
            <div className="font-semibold text-sky-100">{notice.title}</div>
            {notice.description && (
              <p className="text-2xs leading-relaxed text-sky-200/90">{notice.description}</p>
            )}
            {notice.keySnippet && (
              <div className="flex items-center gap-2 pt-1">
                <span className="text-2xs text-sky-300 font-semibold uppercase tracking-wider">Key in clipboard:</span>
                <code className="rounded bg-sky-900/70 border border-sky-700/50 px-2 py-0.5 font-mono text-2xs text-sky-200 select-all">
                  {notice.keySnippet}
                </code>
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss notice"
            onClick={() => setNotice(null)}
            className="text-sky-400 hover:text-white p-1 rounded hover:bg-sky-900/40 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button aria-label="Close" title="Close" type="button" onClick={() => setError(null)} className="text-red-400 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Section 1: Local Developer Keys & Git Registration */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-sky-400" />
              Developer SSH Keys & Git Providers
            </h3>
            <p className="text-txt-muted text-2xs mt-0.5">
              Copy your public keys to clipboard or register them on GitHub/GitLab for push/pull access and commit signing.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void loadKeys();
              void loadSigningConfig();
            }}
            disabled={loadingKeys || loadingSigning}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1 text-xs text-txt-primary hover:bg-app-surface-hover transition-colors disabled:opacity-50"
          >
            <RefreshCw className={classNames('h-3.5 w-3.5', (loadingKeys || loadingSigning) && 'animate-spin')} />
            Refresh
          </button>
        </div>

        {loadingKeys ? (
          <div className="flex items-center justify-center gap-2 py-8 text-txt-muted bg-app-surface rounded-xl border border-border-subtle">
            <Loader2 className="h-4 w-4 animate-spin text-sky-400" /> Scanning developer keys…
          </div>
        ) : keys.length === 0 ? (
          <div className="p-4 text-txt-muted bg-app-surface rounded-xl border border-border-subtle text-center space-y-1">
            <p>No public SSH keys found in <code>~/.ssh</code>, active agent, or global smartcard cache.</p>
            <p className="text-2xs text-txt-muted/80">
              If you use a smartcard, YubiKey, or FIDO2 key, unlock it into the global cache using the card icon in the top bar or under <strong>Settings &gt; Security &amp; Smartcard</strong>.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-divider overflow-hidden rounded-xl border border-border-subtle bg-app-surface">
            {keys.map((k) => {
              const isSigning = isKeyActiveSigning(k);
              return (
                <div key={k.id} className="flex flex-col gap-2 p-3 hover:bg-app-surface-hover/50 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate font-medium text-txt-primary">{k.label}</span>
                      <span
                        className="shrink-0 whitespace-nowrap rounded bg-app-card px-1.5 py-0.5 text-2xs uppercase text-txt-muted border border-border-subtle"
                      >
                        {SOURCE_LABEL[k.source] || k.source}
                      </span>
                      {isSigning && (
                        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-2xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5 font-medium">
                          <Check className="h-3 w-3" /> Active Signing Key
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-2xs text-txt-muted mt-0.5">
                      {k.type}
                      {k.fingerprint ? ` · ${k.fingerprint}` : ''}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* Copy Raw Key */}
                    <button
                      type="button"
                      title="Copy public key to clipboard"
                      onClick={() => void copyKeyOnly(k)}
                      className={classNames(
                        'flex items-center gap-1 text-2xs rounded px-2.5 py-1.5 transition-colors border',
                        copiedKeyId === k.id && copiedAction === 'copy'
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400 font-medium'
                          : 'text-txt-secondary hover:text-txt-primary bg-app-card hover:bg-app-surface border-border-subtle'
                      )}
                    >
                      {copiedKeyId === k.id && copiedAction === 'copy' ? (
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

                    {/* Git Commit Signing Button */}
                    <button
                      type="button"
                      title="Configure Git to sign commits with this key (~/.gitconfig)"
                      onClick={() => void configureSigning(k)}
                      disabled={signingConfiguringId === k.id}
                      className={classNames(
                        'flex items-center gap-1 text-2xs rounded px-2.5 py-1.5 transition-colors border',
                        isSigning
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-medium'
                          : 'text-txt-secondary hover:text-sky-400 bg-app-card hover:bg-app-surface border-border-subtle'
                      )}
                    >
                      {signingConfiguringId === k.id ? (
                        <Loader2 className="h-3 w-3 animate-spin text-sky-400" />
                      ) : (
                        <GitBranch className="h-3 w-3" />
                      )}
                      <span>{isSigning ? 'Sign Active' : 'Git Sign'}</span>
                    </button>

                    {/* Add to GitHub */}
                    <button
                      type="button"
                      title="Register this public key on GitHub (copies key to clipboard and opens browser)"
                      onClick={() => void registerOnGitProvider(k, 'github')}
                      className={classNames(
                        'flex items-center gap-1 text-2xs rounded px-2.5 py-1.5 transition-colors border',
                        copiedKeyId === k.id && copiedAction === 'github'
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400 font-medium'
                          : 'text-txt-secondary hover:text-txt-primary bg-app-card hover:bg-app-surface border-border-subtle'
                      )}
                    >
                      {copiedKeyId === k.id && copiedAction === 'github' ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <ExternalLink className="h-3 w-3" />
                          <span>GitHub</span>
                        </>
                      )}
                    </button>

                    {/* Add to GitLab */}
                    <button
                      type="button"
                      title="Register this public key on GitLab (copies key to clipboard and opens browser)"
                      onClick={() => void registerOnGitProvider(k, 'gitlab')}
                      className={classNames(
                        'flex items-center gap-1 text-2xs rounded px-2.5 py-1.5 transition-colors border',
                        copiedKeyId === k.id && copiedAction === 'gitlab'
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400 font-medium'
                          : 'text-txt-secondary hover:text-txt-primary bg-app-card hover:bg-app-surface border-border-subtle'
                      )}
                    >
                      {copiedKeyId === k.id && copiedAction === 'gitlab' ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <ExternalLink className="h-3 w-3" />
                          <span>GitLab</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 2: Git Commit Signing Status */}
      <div className="space-y-3 rounded-xl border border-border-subtle bg-app-surface p-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-sky-400" />
          <h3 className="text-sm font-semibold text-txt-primary">Git Commit Signing (~/.gitconfig)</h3>
        </div>
        <p className="text-txt-muted text-2xs leading-relaxed">
          SSH commit signing cryptographically signs git commits using your SSH key. GitHub and GitLab will display the green <span className="text-emerald-400 font-semibold">Verified</span> badge on your commits without requiring GPG.
        </p>

        <div className="grid grid-cols-2 gap-3 pt-1">
          <div className="rounded-lg border border-border-subtle bg-app-card p-3 space-y-1">
            <span className="text-txt-muted text-2xs uppercase tracking-wider font-semibold">Signing Format</span>
            <div className="text-xs font-medium text-txt-primary font-mono">
              {signingConfig?.format || 'ssh (default)'}
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-app-card p-3 space-y-1">
            <span className="text-txt-muted text-2xs uppercase tracking-wider font-semibold">Automatic Signing (commit.gpgsign)</span>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium flex items-center gap-1.5">
                {signingConfig?.enabled ? (
                  <span className="text-emerald-400 font-semibold flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Enabled
                  </span>
                ) : (
                  <span className="text-amber-400 font-medium">Not enabled globally</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void toggleSigningEnabled()}
                disabled={togglingSigning || (!signingConfig?.enabled && !signingConfig?.signingKey)}
                title={
                  !signingConfig?.enabled && !signingConfig?.signingKey
                    ? 'Configure a signing key first using Git Sign on a key above'
                    : undefined
                }
                className={classNames(
                  'rounded px-2 py-0.5 text-2xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                  signingConfig?.enabled
                    ? 'border border-border-subtle bg-app-surface text-txt-secondary hover:bg-red-500/15 hover:text-red-300 hover:border-red-500/30'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                )}
              >
                {togglingSigning ? 'Updating…' : signingConfig?.enabled ? 'Disable' : 'Enable Signing'}
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-app-card p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-txt-muted text-2xs uppercase tracking-wider font-semibold">Active Signing Key</span>
            <button
              type="button"
              onClick={() => setShowCustomSigningKey(!showCustomSigningKey)}
              className="text-2xs text-sky-400 hover:text-sky-300 font-medium transition-colors"
            >
              {showCustomSigningKey ? 'Cancel' : signingConfig?.signingKey ? 'Change Key…' : 'Set Key…'}
            </button>
          </div>
          {signingConfig?.signingKey ? (
            <div className="text-xs font-mono text-txt-primary truncate">
              {signingConfig.signingKey}
            </div>
          ) : (
            <div className="text-xs text-txt-muted italic">
              No signing key configured. Click &quot;Git Sign&quot; on any key above or click &quot;Set Key…&quot;.
            </div>
          )}

          {showCustomSigningKey && (
            <div className="pt-2 border-t border-divider space-y-2">
              <label htmlFor="custom-signing-key-input" className="text-2xs text-txt-secondary block">
                Paste an SSH public key (e.g. <code>ssh-rsa AAAAB3…</code> or <code>ssh-ed25519…</code>) or key path:
              </label>
              <div className="flex gap-2">
                <input
                  id="custom-signing-key-input"
                  type="text"
                  value={customKeyText}
                  onChange={(e) => setCustomKeyText(e.target.value)}
                  placeholder="ssh-ed25519 AAAAC3… user@domain"
                  className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-app px-2.5 py-1 text-xs text-txt-primary focus:border-sky-500 focus:outline-none font-mono"
                />
                <button
                  type="button"
                  onClick={() => void handleApplyCustomSigningKey()}
                  disabled={!customKeyText.trim() || savingCustomKey}
                  className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 transition-colors"
                >
                  {savingCustomKey ? 'Saving…' : 'Apply'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 3: SFTP & File Manager Git Integration */}
      <div className="space-y-3 rounded-xl border border-border-subtle bg-app-surface p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 text-sky-400" />
            <h3 className="text-sm font-semibold text-txt-primary">SFTP &amp; File Manager Git Integration</h3>
          </div>
          {onChangeFileManagerGitIntegration && (
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                aria-label="Toggle SFTP & File Manager Git Integration"
                data-testid="toggle-filemanager-git-integration"
                checked={fileManagerGitIntegration}
                onChange={(e) => onChangeFileManagerGitIntegration(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-app-card peer-focus-visible:ring-2 peer-focus-visible:ring-sky-500 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-app-surface rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-border-subtle after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-sky-600 border border-border-subtle"></div>
            </label>
          )}
        </div>
        <p className="text-txt-muted text-2xs leading-relaxed">
          Show Git branch indicators, commit status (ahead/behind/uncommitted changes), and Git operations (Pull, Clone, Open in GitHub/GitLab) in SFTP and local file manager panes. Turn this off if you prefer a clean file browser without Git polling.
        </p>
        <div className="flex items-center gap-2 text-2xs">
          <span className="text-txt-muted">Status:</span>
          {fileManagerGitIntegration ? (
            <span className="flex items-center gap-1 text-emerald-400 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" /> Enabled in SFTP and file manager panes
            </span>
          ) : (
            <span className="text-amber-400 font-medium">
              Disabled (Git branch and actions hidden)
            </span>
          )}
        </div>
      </div>

      {/* Section 4: Fetch Public Keys (username.keys) */}
      <div className="space-y-3 rounded-xl border border-border-subtle bg-app-surface p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-sky-400" />
            <h3 className="text-sm font-semibold text-txt-primary">Lookup Public Keys (username.keys)</h3>
          </div>
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

        <p className="text-txt-muted text-2xs">
          Fetch publicly available SSH keys for any account on {gitProvider === 'github' ? 'GitHub' : gitProvider === 'gitlab' ? 'GitLab' : 'your custom Git server'} to inspect or copy.
        </p>

        <div className="flex gap-2 items-center">
          {gitProvider === 'custom' && (
            <input
              aria-label="Custom Git host"
              type="text"
              value={gitCustomHost}
              onChange={(e) => setGitCustomHost(e.target.value)}
              placeholder="git.example.com"
              className="w-40 rounded-lg border border-border-subtle bg-app-card px-2.5 py-1.5 text-xs text-txt-primary focus:border-sky-500 focus:outline-none"
            />
          )}
          <input
            aria-label={gitProvider === 'github' ? 'GitHub username' : 'GitLab username'}
            type="text"
            value={gitUsername}
            onChange={(e) => setGitUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void fetchGitKeys()}
            placeholder={gitProvider === 'github' ? 'GitHub username (e.g. torvalds)' : 'GitLab username'}
            className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-app-card px-2.5 py-1.5 text-xs text-txt-primary focus:border-sky-500 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void fetchGitKeys()}
            disabled={!gitUsername.trim() || fetchingGit || gitKeyFetchBlocked}
            aria-describedby={gitKeyFetchBlocked ? 'git-key-fetch-blocked' : undefined}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 transition-colors"
          >
            {fetchingGit && <Loader2 className="h-3 w-3 animate-spin" />}
            Fetch keys
          </button>
        </div>
        <FeatureBlockedNotice blocked={gitKeyFetchBlocked} id="git-key-fetch-blocked" />

        {fetchedKeys.length > 0 && (
          <div className="divide-y divide-divider overflow-hidden rounded-lg border border-border-subtle bg-app-card mt-2">
            {fetchedKeys.map((fk) => (
              <div key={fk.id} className="flex items-center justify-between gap-3 p-2.5 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-txt-primary truncate">{fk.label}</div>
                  <div className="font-mono text-2xs text-txt-muted truncate">{fk.line}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    title="Configure Git to sign commits with this key (~/.gitconfig)"
                    onClick={() => void configureSigning(fk)}
                    disabled={signingConfiguringId === fk.id}
                    className={classNames(
                      'flex items-center gap-1 text-2xs rounded px-2 py-1 transition-colors border',
                      isKeyActiveSigning(fk)
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 font-medium'
                        : 'text-txt-secondary hover:text-sky-400 bg-app-card hover:bg-app-surface border-border-subtle'
                    )}
                  >
                    {signingConfiguringId === fk.id ? (
                      <Loader2 className="h-3 w-3 animate-spin text-sky-400" />
                    ) : (
                      <GitBranch className="h-3 w-3" />
                    )}
                    <span>{isKeyActiveSigning(fk) ? 'Sign Active' : 'Git Sign'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void copyKeyOnly(fk)}
                    className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-2xs text-txt-secondary hover:text-txt-primary hover:bg-app-surface transition-colors shrink-0"
                  >
                    <Copy className="h-3 w-3" />
                    Copy
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
