import React, { useEffect, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Globe,
  HelpCircle,
  KeyRound,
  Loader2,
  LogIn,
  ShieldAlert,
  Terminal,
  X,
  XCircle,
} from 'lucide-react';
import type { K8sLoginResult, K8sProfile } from '@shared/types/kubernetes';
import { parseOcLoginCommand } from '@shared/ocLogin';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { defaultProfileName, findMatchingProfile, newProfileId } from '../../lib/k8sProfiles';
import { useOpenShiftWebLogin } from '../../lib/useOpenShiftWebLogin';
import { OpenShiftWebLoginSection } from './OpenShiftWebLoginSection';
import { ELECTRON_IPC_PREFIX } from '../../lib/format';

interface K8sLoginModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (result: K8sLoginResult) => void;
  /** A saved cluster to sign in to again (prefills the fields); omit to add a new one. */
  initialProfile?: K8sProfile | null;
}

type LoginMode = 'browser' | 'token';

export const K8sLoginModal: React.FC<K8sLoginModalProps> = ({ open, onClose, onSuccess, initialProfile }) => {
  const [pasteInput, setPasteInput] = useState('');
  const [server, setServer] = useState('');
  const [token, setToken] = useState('');
  const [namespace, setNamespace] = useState('');
  const [insecureSkipTlsVerify, setInsecureSkipTlsVerify] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<LoginMode>('token');
  const [saveProfile, setSaveProfile] = useState(true);
  const [profileName, setProfileName] = useState('');

  // The bearer token (and the pasted `oc login` command, which contains it) must not stay in memory while the
  // dialog is closed, after a sign-in or a cancel; it used to linger until the next time the dialog opened.
  useEffect(() => {
    if (open) return;
    setToken('');
    setPasteInput('');
  }, [open]);

  // Each time the dialog opens it starts from the profile being signed in to, or from blank.
  useEffect(() => {
    if (!open) return;
    setPasteInput('');
    setServer(initialProfile?.server ?? '');
    setToken('');
    setNamespace(initialProfile?.namespace ?? '');
    setInsecureSkipTlsVerify(initialProfile?.insecureSkipTlsVerify ?? false);
    setProfileName(initialProfile?.name ?? '');
    setSaveProfile(true);
    setShowToken(false);
    setError(null);
    setMode('token');
  }, [open, initialProfile]);

  /** Remembers the cluster as a profile once a sign-in worked; a failure here never undoes the sign-in. */
  const rememberProfile = async (result: K8sLoginResult) => {
    if (!saveProfile) return;
    try {
      // Signing in again to a cluster that already has a profile (same server and project) updates it instead of
      // adding a second profile for the same kubeconfig context.
      const existing =
        initialProfile ??
        findMatchingProfile((await window.multissh.k8sProfilesList?.()) ?? [], {
          id: '',
          name: '',
          server: result.server,
          namespace: namespace.trim() || undefined,
        });
      await window.multissh.k8sProfilesSave({
        id: existing?.id ?? newProfileId(),
        name: profileName.trim() || existing?.name || defaultProfileName(result.server),
        server: result.server,
        insecureSkipTlsVerify,
        namespace: namespace.trim() || undefined,
        contextName: result.contextName,
        lastUsedAt: new Date().toISOString(),
      });
    } catch {
      // The kubeconfig entry exists either way.
    }
  };

  const webLogin = useOpenShiftWebLogin({
    enabled: open,
    server,
    insecureSkipTlsVerify,
    namespace,
    onSuccess: async (result) => {
      await rememberProfile(result);
      onSuccess?.(result);
      onClose();
    },
    onError: setError,
  });

  // Browser sign-in is offered as a choice once the cluster is detected; otherwise the token form is all there is.
  // Detection never overrides a token the user already pasted.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  useEffect(() => {
    if (webLogin.supported && !tokenRef.current.trim()) setMode('browser');
  }, [webLogin.supported]);
  const effectiveMode: LoginMode = webLogin.supported ? mode : 'token';

  // Escape cancels a pending browser sign-in first, otherwise it closes; a stray backdrop click would
  // discard typed input, so it is intentionally ignored.
  useModalDismiss(webLogin.waiting ? webLogin.cancel : onClose, open, !loading);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  if (!open) return null;

  const handlePasteChange = (val: string) => {
    setPasteInput(val);
    const parsed = parseOcLoginCommand(val);
    if (parsed.server) setServer(parsed.server);
    if (parsed.token) setToken(parsed.token);
    if (parsed.insecureSkipTlsVerify !== undefined) {
      setInsecureSkipTlsVerify(parsed.insecureSkipTlsVerify);
    }
    if (parsed.namespace) setNamespace(parsed.namespace);
    if (parsed.server || parsed.token) {
      setError(null);
      setMode('token');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!server.trim()) {
      setError('Server URL is required');
      return;
    }
    if (effectiveMode === 'browser') {
      if (!webLogin.waiting) void webLogin.start();
      return;
    }
    if (!token.trim()) {
      setError('Token is required');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await window.multissh.k8sLogin({
        server: server.trim(),
        token: token.trim(),
        namespace: namespace.trim() || undefined,
        insecureSkipTlsVerify,
      });

      await rememberProfile(result);
      setLoading(false);
      onSuccess?.(result);
      onClose();
    } catch (err: any) {
      setLoading(false);
      const msg = err?.message || String(err);
      setError(msg.replace(ELECTRON_IPC_PREFIX, ''));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="OpenShift / Kubernetes login" className="flex flex-col w-full max-w-xl max-h-[90vh] rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
              <LogIn className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-txt-primary">{initialProfile ? 'Sign in to cluster' : 'OpenShift / Kubernetes Login'}</h2>
              <p className="text-xs text-txt-muted">Log in to a cluster directly without needing the local oc CLI</p>
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="space-y-1.5">
            <div
              role="radiogroup"
              aria-label="Sign-in method"
              className="grid grid-cols-2 gap-1 rounded-xl border border-border-subtle bg-app-surface p-1 text-xs font-medium"
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                if (webLogin.supported) setMode(effectiveMode === 'browser' ? 'token' : 'browser');
              }}
            >
              {(
                [
                  { value: 'browser', label: 'Sign in with browser', Icon: Globe },
                  { value: 'token', label: 'Use a token', Icon: KeyRound },
                ] as const
              ).map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={effectiveMode === value}
                  tabIndex={effectiveMode === value ? 0 : -1}
                  disabled={webLogin.waiting || (value === 'browser' && !webLogin.supported)}
                  onClick={() => setMode(value)}
                  className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50 ${
                    effectiveMode === value
                      ? 'bg-red-600 text-white shadow-sm'
                      : 'text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </div>
            {!webLogin.supported && (
              <p className="px-1 text-xs text-txt-muted" role="status">
                {webLogin.checking
                  ? 'Checking whether this cluster supports browser sign-in…'
                  : server.trim().length < 4
                    ? 'Enter the server URL to check whether browser sign-in is available.'
                    : 'Browser sign-in is not available for this cluster (it needs OpenShift 4.13+ with the built-in OAuth server). Use a token instead.'}
              </p>
            )}
          </div>

          {effectiveMode === 'browser' && (
            <OpenShiftWebLoginSection waiting={webLogin.waiting} onCancel={webLogin.cancel} />
          )}

          {effectiveMode === 'token' && (
            <>
            {/* Quick Paste Box */}
            <div className="rounded-xl border border-border-subtle bg-app-surface p-3.5 space-y-2">
              <div className="flex items-center justify-between text-xs font-medium text-txt-primary">
                <div className="flex items-center gap-1.5">
                  <Terminal className="h-3.5 w-3.5 text-red-400" />
                  <span>Paste `oc login` command</span>
                </div>
                <span className="text-xs text-txt-muted">Auto-populates fields below</span>
              </div>
              <textarea
                aria-label="Paste oc login command"
                rows={2}
                value={pasteInput}
                onChange={(e) => handlePasteChange(e.target.value)}
                placeholder="e.g. oc login --token=sha256~... --server=https://api.cluster.example.com:6443"
                className="w-full rounded-lg border border-border-subtle bg-app-surface-subtle p-2 text-xs font-mono text-txt-primary placeholder:text-txt-muted/70 focus:border-red-500/50 focus:outline-none transition-colors resize-none"
              />
              <div className="flex items-start gap-1.5 text-xs text-txt-muted">
                <HelpCircle className="h-3 w-3 shrink-0 mt-0.5 text-txt-muted/80" />
                <span>
                  Tip: In OpenShift Web Console, click your username in the top right &rarr;{' '}
                  <strong className="text-txt-secondary">Copy login command</strong> &rarr;{' '}
                  <strong className="text-txt-secondary">Display Token</strong>, and paste it here.
                </span>
              </div>
            </div>
            </>
          )}

          {error && (
            <div role="alert" className="rounded-xl border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300 flex items-start gap-2">
              <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="flex-1 whitespace-pre-wrap">{error}</div>
            </div>
          )}

          {/* Form */}
          <form id="k8s-login-form" onSubmit={handleSubmit} className="space-y-3.5 text-xs">
            <div>
              <label className="block text-xs font-medium text-txt-secondary mb-1">
                Server URL <span className="text-red-400">*</span>
              </label>
              <input
                aria-label="API server URL"
                type="text"
                required
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://api.mycluster.example.com:6443"
                className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs font-mono text-txt-primary focus:border-red-500/50 focus:outline-none transition-colors"
              />
            </div>

            {effectiveMode === 'token' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-txt-secondary">
                    API Token <span className="text-red-400">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="flex items-center gap-1 text-xs text-txt-muted hover:text-txt-primary transition-colors"
                  >
                    {showToken ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                    {showToken ? 'Hide token' : 'Show token'}
                  </button>
                </div>
                <div className="relative">
                  <input
                    aria-label="Token"
                    type={showToken ? 'text' : 'password'}
                    required
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="sha256~..."
                    className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 pr-9 text-xs font-mono text-txt-primary focus:border-red-500/50 focus:outline-none transition-colors"
                  />
                  <KeyRound className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-txt-muted pointer-events-none" />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-txt-secondary mb-1">
                Default Project / Namespace <span className="text-txt-muted font-normal">(optional)</span>
              </label>
              <input
                aria-label="Default project / namespace"
                type="text"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="Leave empty to list every project you can access"
                className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs text-txt-primary placeholder:text-txt-muted/70 focus:border-red-500/50 focus:outline-none transition-colors"
              />
              {namespace.trim() && (
                <p className="mt-1 text-xs text-txt-muted">Only this project is shown in the cluster tree.</p>
              )}
            </div>

            <div className="rounded-lg border border-border-subtle/80 bg-app-surface-subtle p-3 space-y-2">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={saveProfile}
                  onChange={(e) => setSaveProfile(e.target.checked)}
                  className="rounded border-border-subtle text-red-500 focus:ring-0"
                />
                <span className="text-xs font-medium text-txt-primary">Save as profile</span>
              </label>
              {saveProfile && (
                <input
                  aria-label="Profile name"
                  type="text"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder={server.trim() ? defaultProfileName(server) : 'Profile name (defaults to the API host)'}
                  className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs text-txt-primary placeholder:text-txt-muted/70 focus:border-red-500/50 focus:outline-none transition-colors"
                />
              )}
            </div>

            <div className="rounded-lg border border-border-subtle/80 bg-app-surface-subtle p-3">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={insecureSkipTlsVerify}
                  onChange={(e) => setInsecureSkipTlsVerify(e.target.checked)}
                  className="mt-0.5 rounded border-border-subtle text-red-500 focus:ring-0"
                />
                <div className="text-xs">
                  <span className="font-medium text-txt-primary">Skip TLS certificate verification</span>
                  <p className="text-xs text-txt-muted mt-0.5">
                    Enable if your cluster uses private, self-signed, or internal CA certificates (equivalent to{' '}
                    <code className="rounded bg-app-surface px-1 py-0.5 text-2xs font-mono">
                      --insecure-skip-tls-verify=true
                    </code>
                    ).
                  </p>
                </div>
              </label>
            </div>
          </form>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-divider bg-app-surface px-5 py-3">
          <div className="flex items-center gap-1.5 text-xs text-txt-muted">
            <ShieldAlert className="h-3.5 w-3.5 text-txt-muted" />
            <span>Updates ~/.kube/config automatically</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={onClose}
              className="rounded-lg px-3.5 py-1.5 text-xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="k8s-login-form"
              disabled={loading || webLogin.waiting}
              className="flex items-center gap-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white px-4 py-1.5 text-xs font-medium shadow-sm transition-colors disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : effectiveMode === 'browser' ? (
                <>
                  <Globe className="h-3.5 w-3.5" />
                  <span>Sign in with browser</span>
                </>
              ) : (
                <>
                  <LogIn className="h-3.5 w-3.5" />
                  <span>Log in & Connect</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
