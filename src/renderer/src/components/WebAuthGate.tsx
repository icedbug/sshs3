import React, { useEffect, useState, useCallback } from 'react';
import { McpKeysPanel } from './McpKeysPanel';
import {
  isWebBrowserMode,
  ensureWebClientBridgeInstalled,
  connectWebClientBridge,
  disconnectWebClientBridge,
  getStoredWebSessionToken,
  setStoredWebSessionToken,
  onWebConnectionStateChange,
} from '../lib/webClientBridge';

interface WebUserPublic {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  createdAt: string | number;
  lastLoginAt?: string | number;
  sshPublicKey: string;
}

interface WebInvitePublic {
  token: string;
  role: 'admin' | 'member';
  createdBy: string;
  createdAt: string | number;
  expiresAt: string | number;
  maxUses: number;
  usedCount?: number;
  uses?: number;
  note?: string;
}

async function webApiFetch<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredWebSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data as T;
}

export const WebAuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const inWebMode = isWebBrowserMode();

  const [loading, setLoading] = useState<boolean>(inWebMode);
  const [initialized, setInitialized] = useState<boolean>(true);
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [user, setUser] = useState<WebUserPublic | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);

  // Auth form states
  const [authMode, setAuthMode] = useState<'login' | 'invite'>('login');
  const [inviteFromUrl, setInviteFromUrl] = useState<boolean>(false);
  const [showRawInviteInput, setShowRawInviteInput] = useState<boolean>(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // User / Admin modal states
  const [showModal, setShowModal] = useState(false);
  const [modalTab, setModalTab] = useState<'ssh' | 'team'>('ssh');
  const [justOnboarded, setJustOnboarded] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [customPrivateKey, setCustomPrivateKey] = useState('');
  const [showImportKey, setShowImportKey] = useState(false);
  const [keyStatusMsg, setKeyStatusMsg] = useState<string | null>(null);
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [passwordStatusMsg, setPasswordStatusMsg] = useState<string | null>(null);

  // Admin states
  const [usersList, setUsersList] = useState<WebUserPublic[]>([]);
  const [invitesList, setInvitesList] = useState<WebInvitePublic[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'member' | 'admin'>('member');
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [inviteMaxUses, setInviteMaxUses] = useState(5);
  const [inviteNote, setInviteNote] = useState('');
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [adminMsg, setAdminMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!inWebMode) return;
    ensureWebClientBridgeInstalled();

    const params = new URLSearchParams(window.location.search);
    const urlInvite = params.get('invite');
    if (urlInvite) {
      setInviteToken(urlInvite);
      setInviteFromUrl(true);
      setAuthMode('invite');
    }

    const unsubWs = onWebConnectionStateChange((connected) => {
      setWsConnected(connected);
    });

    webApiFetch<{ initialized: boolean; authenticated: boolean; user: WebUserPublic | null }>('/api/auth/status')
      .then((status) => {
        setInitialized(status.initialized);
        if (status.authenticated && status.user && !urlInvite) {
          connectWebClientBridge(getStoredWebSessionToken());
          setUser(status.user);
          setAuthenticated(true);
        } else {
          setAuthenticated(false);
          setUser(null);
        }
      })
      .catch(() => {
        setAuthenticated(false);
      })
      .finally(() => {
        setLoading(false);
      });

    return () => {
      unsubWs();
    };
  }, [inWebMode]);

  const loadAdminData = useCallback(async () => {
    if (!user || user.role !== 'admin') return;
    try {
      const [uRes, iRes] = await Promise.all([
        webApiFetch<{ users: WebUserPublic[] }>('/api/admin/users'),
        webApiFetch<{ invites: WebInvitePublic[] }>('/api/admin/invites'),
      ]);
      setUsersList(uRes.users || []);
      setInvitesList(iRes.invites || []);
    } catch (err: any) {
      setAdminMsg(err?.message || 'Could not load the admin data');
    }
  }, [user]);

  useEffect(() => {
    if (showModal && modalTab === 'team' && user?.role === 'admin') {
      loadAdminData();
    }
  }, [showModal, modalTab, user, loadAdminData]);

  if (!inWebMode) {
    return <>{children}</>;
  }

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2400);
  };

  const handleAuthSuccess = (token: string, loggedInUser: WebUserPublic, isFirstTime = false) => {
    setStoredWebSessionToken(token);
    connectWebClientBridge(token);
    setUser(loggedInUser);
    setInitialized(true);
    setAuthenticated(true);
    setPassword('');
    setAuthError(null);
    if (isFirstTime) {
      setJustOnboarded(true);
    }
    if (window.location.search.includes('invite=')) {
      window.history.replaceState({}, '', window.location.pathname);
    }
  };

  const handleInitialSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setSubmitting(true);
    try {
      const res = await webApiFetch<{ token: string; sessionToken?: string; user: WebUserPublic }>('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
          password,
        }),
      });
      handleAuthSuccess(res.token || res.sessionToken || '', res.user, true);
    } catch (err: any) {
      setAuthError(err?.message || 'Could not create the admin account');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setSubmitting(true);
    try {
      const res = await webApiFetch<{ token: string; sessionToken?: string; user: WebUserPublic }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });
      handleAuthSuccess(res.token || res.sessionToken || '', res.user, false);
    } catch (err: any) {
      setAuthError(err?.message || 'Wrong user name or password');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRedeemInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setSubmitting(true);
    try {
      const res = await webApiFetch<{ token: string; sessionToken?: string; user: WebUserPublic }>(
        '/api/auth/register-invite',
        {
          method: 'POST',
          body: JSON.stringify({
            inviteToken: inviteToken.trim(),
            username: username.trim(),
            displayName: displayName.trim() || username.trim(),
            password,
          }),
        }
      );
      handleAuthSuccess(res.token || res.sessionToken || '', res.user, true);
    } catch (err: any) {
      setAuthError(err?.message || 'The invite code could not be used');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await webApiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setStoredWebSessionToken(null);
    disconnectWebClientBridge();
    setAuthenticated(false);
    setUser(null);
    setShowModal(false);
    setJustOnboarded(false);
  };

  const handleRotateSshKey = async () => {
    setKeyStatusMsg(null);
    try {
      const res = await webApiFetch<{ sshPublicKey: string; publicKey?: string }>('/api/user/ssh-key', {
        method: 'POST',
        body: JSON.stringify({ rotate: true }),
      });
      if (user) {
        setUser({ ...user, sshPublicKey: res.sshPublicKey || res.publicKey || '' });
      }
      setKeyStatusMsg('A new Ed25519 SSH key was generated on the server');
    } catch (err: any) {
      setKeyStatusMsg(`Error: ${err?.message || 'Could not rotate the SSH key'}`);
    }
  };

  const handleImportSshKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyStatusMsg(null);
    try {
      const res = await webApiFetch<{ sshPublicKey: string; publicKey?: string }>('/api/user/ssh-key', {
        method: 'POST',
        body: JSON.stringify({ privateKey: customPrivateKey }),
      });
      if (user) {
        setUser({ ...user, sshPublicKey: res.sshPublicKey || res.publicKey || '' });
      }
      setCustomPrivateKey('');
      setShowImportKey(false);
      setKeyStatusMsg('Your private SSH key was imported and stored');
    } catch (err: any) {
      setKeyStatusMsg(`Error: ${err?.message || 'Could not import the SSH key'}`);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminMsg(null);
    try {
      await webApiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername.trim(),
          displayName: newDisplayName.trim() || newUsername.trim(),
          password: newPassword,
          role: newRole,
        }),
      });
      setNewUsername('');
      setNewDisplayName('');
      setNewPassword('');
      setAdminMsg('User account created');
      await loadAdminData();
    } catch (err: any) {
      setAdminMsg(`Error: ${err?.message || 'Could not create the user'}`);
    }
  };

  const handleDeleteUser = async (targetUserId: string) => {
    setAdminMsg(null);
    try {
      await webApiFetch(`/api/admin/users/${encodeURIComponent(targetUserId)}`, {
        method: 'DELETE',
      });
      await loadAdminData();
    } catch (err: any) {
      setAdminMsg(`Error: ${err?.message || 'Could not remove the user'}`);
    }
  };

  const handleCreateInvite = async () => {
    setAdminMsg(null);
    try {
      const res = await webApiFetch<{ invite: WebInvitePublic }>('/api/admin/invites', {
        method: 'POST',
        body: JSON.stringify({
          role: inviteRole,
          maxUses: inviteMaxUses,
          expiresInHours: 168,
          note: inviteNote.trim() || undefined,
        }),
      });
      const url = `${window.location.origin}/?invite=${res.invite.token}`;
      setLatestInviteUrl(url);
      copyToClipboard(url, 'invite-url');
      setInviteNote('');
      await loadAdminData();
    } catch (err: any) {
      setAdminMsg(`Error: ${err?.message || 'Could not create the invite link'}`);
    }
  };

  const handleRevokeInvite = async (token: string) => {
    setAdminMsg(null);
    try {
      await webApiFetch(`/api/admin/invites/${encodeURIComponent(token)}`, {
        method: 'DELETE',
      });
      setAdminMsg('Invite code revoked.');
      await loadAdminData();
    } catch (err: any) {
      setAdminMsg(`Error: ${err?.message || 'Could not revoke the invite code'}`);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordStatusMsg(null);
    try {
      await webApiFetch('/api/user/password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: currentPasswordInput,
          newPassword: newPasswordInput,
        }),
      });
      setCurrentPasswordInput('');
      setNewPasswordInput('');
      setPasswordStatusMsg('The password was updated');
    } catch (err: any) {
      setPasswordStatusMsg(`Error: ${err?.message || 'Could not change the password'}`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen w-full bg-[#090d16] text-slate-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-9 h-9 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
          <div className="text-sm text-slate-400 font-mono">Connecting to the sshs3 web workspace…</div>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen w-full bg-[#090d16] text-slate-100 flex items-center justify-center p-4 relative overflow-hidden">
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-32 -right-32 w-96 h-96 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />

        <div className="w-full max-w-md rounded-2xl border border-slate-800/90 bg-[#0f1624]/95 shadow-2xl p-6 space-y-6 relative z-10">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-medium">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                sshs3 Multi-User Web Workspace
              </div>
              <span className="text-[11px] font-mono text-slate-500">VM Server</span>
            </div>

            <h1 className="text-xl font-bold text-white tracking-tight pt-1">
              {!initialized
                ? 'Create the admin account (first start)'
                : authMode === 'invite'
                  ? 'Join the team workspace'
                  : 'Sign in to sshs3'}
            </h1>
            <p className="text-xs text-slate-400 leading-relaxed">
              {!initialized
                ? 'Welcome. Create the administrator account for this server. You get a personal SSH key and can invite your team with a link.'
                : authMode === 'invite'
                  ? 'Create your personal account. You get your own SSH key on the server and access to the team\'s shared VMs, clusters, S3 bucket and team memory.'
                  : 'Sign in to open your own terminal tabs and work in the team\'s shared workspace.'}
            </p>
          </div>

          {!initialized && (
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-cyan-300">1. Admin account</div>
                <div className="text-slate-400 mt-0.5">Create your account below</div>
              </div>
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-emerald-300">2. Your own SSH key</div>
                <div className="text-slate-400 mt-0.5">Generated for you</div>
              </div>
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-indigo-300">3. Invite the team</div>
                <div className="text-slate-400 mt-0.5">Share an invite link</div>
              </div>
            </div>
          )}

          {authError && (
            <div role="alert" className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3.5 py-2.5 text-xs text-rose-300">
              {authError}
            </div>
          )}

          {!initialized ? (
            <form onSubmit={handleInitialSetup} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">User name (for signing in)</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. jacob"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Display name in the team</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Jacob (Admin)"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Password (at least 6 characters)</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold py-2.5 text-sm transition shadow-lg shadow-cyan-500/15"
              >
                {submitting ? 'Creating admin and SSH key…' : 'Create the admin account and start sshs3'}
              </button>
            </form>
          ) : authMode === 'invite' ? (
            <form onSubmit={handleRedeemInvite} className="space-y-4">
              {inviteFromUrl && inviteToken && !showRawInviteInput ? (
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 flex items-center justify-between gap-2">
                  <div className="text-xs text-emerald-200">
                    <span className="font-semibold text-emerald-300">✓ Invite link accepted.</span> Choose your
                    user name and password below.
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowRawInviteInput(true)}
                    className="text-[11px] text-emerald-300 hover:underline shrink-0"
                  >
                    Change code
                  </button>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Invite code</label>
                  <input
                    type="text"
                    required
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    placeholder="Paste the invite code…"
                    className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-400"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Choose a user name</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. erik"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Your display name in the team</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Erik"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Choose a password (at least 6 characters)</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold py-2.5 text-sm transition shadow-lg shadow-cyan-500/15"
              >
                {submitting ? 'Creating account and SSH key…' : 'Join the team and open the workspace'}
              </button>
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError(null);
                  }}
                  className="text-xs text-cyan-400 hover:underline"
                >
                  Already have an account? Sign in here
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">User name</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="User name"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold py-2.5 text-sm transition shadow-lg shadow-cyan-500/15"
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('invite');
                    setAuthError(null);
                  }}
                  className="text-xs text-cyan-400 hover:underline"
                >
                  Got an invite code from a teammate? Join here
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  const authorizedKeysCmd = user?.sshPublicKey
    ? `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${user.sshPublicKey}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
    : '';

  return (
    <>
      {children}

      {/* Onboarding Quick-Start Banner right after creating account / joining team */}
      {justOnboarded && user && !showModal && (
        <div className="fixed bottom-14 right-3 z-[9991] w-full max-w-md rounded-2xl border border-cyan-500/40 bg-[#0f1624]/95 p-4 shadow-2xl backdrop-blur space-y-3 text-xs text-slate-200">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-white flex items-center gap-1.5">
                <span>🎉 Welcome, {user.displayName}</span>
              </div>
              <p className="text-slate-400 mt-0.5 leading-relaxed">
                Your personal <code className="text-cyan-300">ssh-ed25519</code> key has been created on the server.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setJustOnboarded(false)}
              aria-label="Dismiss"
              className="text-slate-400 hover:text-white px-1.5 py-0.5"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => copyToClipboard(user.sshPublicKey, 'onboard-key')}
              className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition"
            >
              {copiedText === 'onboard-key' ? '✓ SSH key copied' : '🔑 Copy my public SSH key'}
            </button>
            {user.role === 'admin' && (
              <button
                type="button"
                onClick={() => {
                  setModalTab('team');
                  setShowModal(true);
                  setJustOnboarded(false);
                }}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-medium transition"
              >
                👥 Invite teammates
              </button>
            )}
          </div>
        </div>
      )}

      {/* Floating Web User & Team Admin Pill */}
      <div className="fixed bottom-3 right-3 z-[9990] flex items-center gap-1.5 rounded-full bg-slate-900/95 border border-slate-700/90 p-1 pl-3 shadow-xl backdrop-blur">
        <span
          className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
          title={wsConnected ? 'Live connection is up' : 'Reconnecting…'}
        />
        <span className="text-xs font-medium text-slate-200 mr-1">{user?.displayName || user?.username}</span>
        <button
          type="button"
          onClick={() => {
            setModalTab('ssh');
            setShowModal(true);
          }}
          className="px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-[11px] text-cyan-300 font-medium transition"
        >
          🔑 SSH key
        </button>
        {user?.role === 'admin' && (
          <button
            type="button"
            onClick={() => {
              setModalTab('team');
              setShowModal(true);
            }}
            className="px-2.5 py-1 rounded-full bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 text-[11px] text-cyan-200 font-medium transition"
          >
            👥 Invite / team
          </button>
        )}
      </div>

      {/* Web Account, SSH Key & Team Admin Modal */}
      {showModal && user && (
        <div className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-[#0f1624] text-slate-100 shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-300 font-bold text-sm">
                  {(user.displayName || user.username).slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="text-sm font-semibold text-white flex items-center gap-2">
                    {user.displayName}
                    <span className="text-[11px] font-mono text-slate-400">(@{user.username})</span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Signed in to the sshs3 web server
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-medium transition"
                >
                  Sign out
                </button>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
                >
                  Close
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-800 px-5 bg-slate-950/40">
              <button
                type="button"
                onClick={() => setModalTab('ssh')}
                className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition ${
                  modalTab === 'ssh'
                    ? 'border-cyan-400 text-cyan-300'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                🔑 My SSH key on the server
              </button>
              {user.role === 'admin' && (
                <button
                  type="button"
                  onClick={() => setModalTab('team')}
                  className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition ${
                    modalTab === 'team'
                      ? 'border-cyan-400 text-cyan-300'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  👥 Invites and user accounts
                </button>
              )}
            </div>

            <div className="p-5 overflow-y-auto space-y-5 text-xs">
              {modalTab === 'ssh' && (
                <div className="space-y-4">
                  <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Your personal SSH key on the server (Ed25519)</h3>
                        <p className="text-slate-400 mt-0.5 leading-relaxed">
                          When you connect to the team's shared VMs in the browser, sshs3 uses your own
                          private SSH key on the server. Add the public key below to the target VMs.
                        </p>
                      </div>
                    </div>

                    <div className="rounded-lg bg-slate-950 border border-slate-800 p-3 font-mono text-[11px] text-cyan-200 break-all select-all">
                      {user.sshPublicKey || 'No public key found'}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyToClipboard(user.sshPublicKey, 'pubkey')}
                        className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition"
                      >
                        {copiedText === 'pubkey' ? '✓ Copied' : 'Copy public SSH key'}
                      </button>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(authorizedKeysCmd, 'authcmd')}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition"
                      >
                        {copiedText === 'authcmd'
                          ? '✓ Command copied'
                          : 'Copy the command for ~/.ssh/authorized_keys'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowImportKey((v) => !v)}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
                      >
                        Import your own private key
                      </button>
                      <button
                        type="button"
                        onClick={handleRotateSshKey}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-300 transition"
                      >
                        Rotate / generate a new one
                      </button>
                    </div>

                    {keyStatusMsg && (
                      <div className="rounded-lg bg-cyan-500/10 border border-cyan-500/30 px-3 py-2 text-cyan-200">
                        {keyStatusMsg}
                      </div>
                    )}

                    {showImportKey && (
                      <form onSubmit={handleImportSshKey} className="space-y-2 pt-2 border-t border-slate-800">
                        <label className="block text-slate-300 font-medium">
                          Paste your private OpenSSH key (-----BEGIN OPENSSH PRIVATE KEY-----)
                        </label>
                        <textarea
                          rows={5}
                          required
                          value={customPrivateKey}
                          onChange={(e) => setCustomPrivateKey(e.target.value)}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                          className="w-full rounded-lg bg-slate-950 border border-slate-700 p-2.5 font-mono text-[11px] text-white"
                        />
                        <button
                          type="submit"
                          className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold"
                        >
                          Save private SSH key
                        </button>
                      </form>
                    )}
                  </div>

                  {/* Keys for the person's own agents */}
                  <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4">
                    <McpKeysPanel api={webApiFetch} origin={typeof window !== 'undefined' ? window.location.origin : ''} />
                  </div>

                  {/* Password change card */}
                  <form
                    onSubmit={handleChangePassword}
                    className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-3"
                  >
                    <h3 className="text-sm font-semibold text-white">Change password</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="password"
                        required
                        value={currentPasswordInput}
                        onChange={(e) => setCurrentPasswordInput(e.target.value)}
                        placeholder="Current password"
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                      />
                      <input
                        type="password"
                        required
                        minLength={6}
                        value={newPasswordInput}
                        onChange={(e) => setNewPasswordInput(e.target.value)}
                        placeholder="New password (at least 6 characters)"
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                      />
                    </div>
                    <button
                      type="submit"
                      className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-medium"
                    >
                      Update password
                    </button>
                    {passwordStatusMsg && (
                      <div className="rounded-lg bg-cyan-500/10 border border-cyan-500/30 px-3 py-2 text-cyan-200">
                        {passwordStatusMsg}
                      </div>
                    )}
                  </form>
                </div>
              )}

              {modalTab === 'team' && user.role === 'admin' && (
                <div className="space-y-5">
                  {adminMsg && (
                    <div className="rounded-lg bg-cyan-500/10 border border-cyan-500/30 px-3 py-2 text-cyan-200">
                      {adminMsg}
                    </div>
                  )}

                  {/* 1-Click Invite Generator */}
                  <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-white">Create an invite link</h3>
                    <p className="text-slate-400">
                      Send the link to a teammate: they choose their own password and get access to the team's shared
                      VMs, clusters, S3 workspace and team memory.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div>
                        <label className="block text-slate-400 mb-1">Role</label>
                        <select
                          value={inviteRole}
                          onChange={(e) => setInviteRole(e.target.value as 'member' | 'admin')}
                          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                        >
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-slate-400 mb-1">Maximum number of sign-ups</label>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={inviteMaxUses}
                          onChange={(e) => setInviteMaxUses(Number(e.target.value) || 1)}
                          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-slate-400 mb-1">Note (optional)</label>
                        <input
                          type="text"
                          value={inviteNote}
                          onChange={(e) => setInviteNote(e.target.value)}
                          placeholder="e.g. the DevOps team"
                          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleCreateInvite}
                      className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition"
                    >
                      Create and copy invite link
                    </button>

                    {latestInviteUrl && (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 space-y-1.5">
                        <div className="text-emerald-300 font-semibold">
                          ✓ Invite link created and copied to the clipboard
                        </div>
                        <div className="font-mono text-[11px] text-slate-200 break-all select-all">
                          {latestInviteUrl}
                        </div>
                      </div>
                    )}

                    {invitesList.length > 0 && (
                      <div className="pt-3 border-t border-slate-800 space-y-2">
                        <div className="text-xs font-semibold text-slate-300">
                          Active invite links ({invitesList.length})
                        </div>
                        <div className="divide-y divide-slate-800">
                          {invitesList.map((inv) => {
                            const invUrl = `${window.location.origin}/?invite=${inv.token}`;
                            return (
                              <div key={inv.token} className="py-2 flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-mono text-[11px] text-cyan-200 truncate">
                                    {inv.token}
                                    {inv.note ? ` · ${inv.note}` : ''}
                                  </div>
                                  <div className="text-[10px] text-slate-400">
                                    Role: {inv.role} · Used: {inv.usedCount}/{inv.maxUses}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => copyToClipboard(invUrl, `inv-${inv.token}`)}
                                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px]"
                                  >
                                    {copiedText === `inv-${inv.token}` ? '✓ Copied' : 'Copy link'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleRevokeInvite(inv.token)}
                                    className="px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-[11px]"
                                  >
                                    Revoke
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Direct user creation */}
                  <form
                    onSubmit={handleCreateUser}
                    className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-3"
                  >
                    <h3 className="text-sm font-semibold text-white">Create a user account</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                      <input
                        type="text"
                        required
                        value={newUsername}
                        onChange={(e) => setNewUsername(e.target.value)}
                        placeholder="User name"
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                      />
                      <input
                        type="text"
                        value={newDisplayName}
                        onChange={(e) => setNewDisplayName(e.target.value)}
                        placeholder="Display name"
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                      />
                      <input
                        type="password"
                        required
                        minLength={6}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Password (min 6)"
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                      />
                      <select
                        value={newRole}
                        onChange={(e) => setNewRole(e.target.value as 'member' | 'admin')}
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <button
                      type="submit"
                      className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-medium"
                    >
                      + Add user
                    </button>
                  </form>

                  {/* Active users list */}
                  <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-2.5">
                    <h3 className="text-sm font-semibold text-white">
                      Users on this server ({usersList.length})
                    </h3>
                    <div className="divide-y divide-slate-800">
                      {usersList.map((u) => (
                        <div key={u.id} className="py-2 flex items-center justify-between gap-2">
                          <div>
                            <div className="font-medium text-white flex items-center gap-2">
                              {u.displayName}
                              <span className="font-mono text-slate-400">@{u.username}</span>
                              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px]">
                                {u.role}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono truncate max-w-md">
                              {u.sshPublicKey}
                            </div>
                          </div>
                          {u.id !== user.id && (
                            <button
                              type="button"
                              onClick={() => handleDeleteUser(u.id)}
                              className="px-2.5 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 text-[11px]"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
