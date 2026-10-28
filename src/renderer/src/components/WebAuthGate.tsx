import React, { useEffect, useState, useCallback } from 'react';
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
      setAdminMsg(err?.message || 'Kunde inte ladda admin-data');
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
      setAuthError(err?.message || 'Kunde inte skapa admin-konto');
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
      setAuthError(err?.message || 'Felaktigt användarnamn eller lösenord');
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
      setAuthError(err?.message || 'Kunde inte lösa in invite-kod');
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
      setKeyStatusMsg('Ny Ed25519 SSH-nyckel har genererats på servern!');
    } catch (err: any) {
      setKeyStatusMsg(`Fel: ${err?.message || 'Kunde inte rotera SSH-nyckel'}`);
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
      setKeyStatusMsg('Din privata SSH-nyckel har importerats och sparats säkert!');
    } catch (err: any) {
      setKeyStatusMsg(`Fel: ${err?.message || 'Kunde inte importera SSH-nyckel'}`);
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
      setAdminMsg('Användarkonto skapat!');
      await loadAdminData();
    } catch (err: any) {
      setAdminMsg(`Fel: ${err?.message || 'Kunde inte skapa användare'}`);
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
      setAdminMsg(`Fel: ${err?.message || 'Kunde inte ta bort användare'}`);
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
      setAdminMsg(`Fel: ${err?.message || 'Kunde inte skapa invite-länk'}`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen w-full bg-[#090d16] text-slate-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-9 h-9 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
          <div className="text-sm text-slate-400 font-mono">Ansluter till sshs3 Web Workspace...</div>
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
                ? 'Skapa Admin-konto (Första uppstart)'
                : authMode === 'invite'
                  ? 'Gå med i Teamets Workspace'
                  : 'Logga in på sshs3'}
            </h1>
            <p className="text-xs text-slate-400 leading-relaxed">
              {!initialized
                ? 'Välkommen! Skapa administratörskontot för den här VM:en. Du får direkt en personlig SSH-nyckel och kan bjuda in dina kompisar med en 1-klickslänk.'
                : authMode === 'invite'
                  ? 'Skapa ditt personliga konto. Du får en egen SSH-nyckel på servern och direkt tillgång till teamets delade VM:ar, kluster, S3-bucket och AI-minnen.'
                  : 'Logga in för att öppna dina egna terminal-flikar och samarbeta i teamets delade arbetsyta.'}
            </p>
          </div>

          {!initialized && (
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-cyan-300">1. Admin-konto</div>
                <div className="text-slate-400 mt-0.5">Skapa ditt konto nedan</div>
              </div>
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-emerald-300">2. Egen SSH-nyckel</div>
                <div className="text-slate-400 mt-0.5">Genereras automatiskt</div>
              </div>
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-indigo-300">3. Bjud in teamet</div>
                <div className="text-slate-400 mt-0.5">Dela 1-klicks invite-länk</div>
              </div>
            </div>
          )}

          {authError && (
            <div className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3.5 py-2.5 text-xs text-rose-300">
              {authError}
            </div>
          )}

          {!initialized ? (
            <form onSubmit={handleInitialSetup} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Användarnamn (för inloggning)</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="t.ex. jacob"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Visningsnamn i teamet</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="t.ex. Jacob (Admin)"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Lösenord (minst 6 tecken)</label>
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
                {submitting ? 'Skapar Admin & SSH-nyckel...' : 'Skapa Admin-konto & Starta sshs3'}
              </button>
            </form>
          ) : authMode === 'invite' ? (
            <form onSubmit={handleRedeemInvite} className="space-y-4">
              {inviteFromUrl && inviteToken && !showRawInviteInput ? (
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 flex items-center justify-between gap-2">
                  <div className="text-xs text-emerald-200">
                    <span className="font-semibold text-emerald-300">✓ Inbjudningslänk aktiverad!</span> Välj ditt
                    användarnamn och lösenord nedan.
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowRawInviteInput(true)}
                    className="text-[11px] text-emerald-300 hover:underline shrink-0"
                  >
                    Ändra kod
                  </button>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">Inbjudningskod (Invite Token)</label>
                  <input
                    type="text"
                    required
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    placeholder="Klistra in invite-kod..."
                    className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-400"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Välj användarnamn</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="t.ex. erik"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Ditt visningsnamn i teamet</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="t.ex. Erik"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Välj lösenord (minst 6 tecken)</label>
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
                {submitting ? 'Skapar konto & SSH-nyckel...' : 'Gå med i Teamet & Öppna Workspace'}
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
                  Har du redan ett konto? Logga in här
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Användarnamn</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Användarnamn"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Lösenord</label>
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
                {submitting ? 'Loggar in...' : 'Logga in på Workspace'}
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
                  Har du fått en Invite-kod från en kompis? Gå med här
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
                <span>🎉 Välkommen in, {user.displayName}!</span>
              </div>
              <p className="text-slate-400 mt-0.5 leading-relaxed">
                Din personliga <code className="text-cyan-300">ssh-ed25519</code>-nyckel är nu skapad på servern.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setJustOnboarded(false)}
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
              {copiedText === 'onboard-key' ? '✓ SSH-nyckel kopierad!' : '🔑 Kopiera min publika SSH-nyckel'}
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
                👥 Bjud in kompisar (Invite-länk)
              </button>
            )}
          </div>
        </div>
      )}

      {/* Floating Web User & Team Admin Pill */}
      <div className="fixed bottom-3 right-3 z-[9990] flex items-center gap-1.5 rounded-full bg-slate-900/95 border border-slate-700/90 p-1 pl-3 shadow-xl backdrop-blur">
        <span
          className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
          title={wsConnected ? 'Realtids-WebSocket ansluten' : 'Återansluter...'}
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
          🔑 SSH-nyckel
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
            👥 Bjud in / Team
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
                    Inloggad på sshs3 Web Server · Hybritt Team-läge aktivt
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-medium transition"
                >
                  Logga ut
                </button>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
                >
                  Stäng
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
                🔑 Min SSH-nyckel på servern
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
                  👥 Bjud in kompisar & Användarkonton
                </button>
              )}
            </div>

            <div className="p-5 overflow-y-auto space-y-5 text-xs">
              {modalTab === 'ssh' && (
                <div className="space-y-4">
                  <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Din personliga Server-SSH-nyckel (Ed25519)</h3>
                        <p className="text-slate-400 mt-0.5 leading-relaxed">
                          När du ansluter till teamets delade VM:ar i webbläsaren använder sshs3 automatiskt din egen
                          privata SSH-nyckel på servern. Lägg in den publika nyckeln nedan på mål-VM:arna.
                        </p>
                      </div>
                    </div>

                    <div className="rounded-lg bg-slate-950 border border-slate-800 p-3 font-mono text-[11px] text-cyan-200 break-all select-all">
                      {user.sshPublicKey || 'Ingen publik nyckel hittades'}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => copyToClipboard(user.sshPublicKey, 'pubkey')}
                        className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition"
                      >
                        {copiedText === 'pubkey' ? '✓ Kopierad!' : 'Kopiera publik SSH-nyckel'}
                      </button>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(authorizedKeysCmd, 'authcmd')}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition"
                      >
                        {copiedText === 'authcmd'
                          ? '✓ Kommando kopierat!'
                          : 'Kopiera 1-klickskommando för ~/.ssh/authorized_keys'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowImportKey((v) => !v)}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
                      >
                        Importera egen privat nyckel
                      </button>
                      <button
                        type="button"
                        onClick={handleRotateSshKey}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-amber-300 transition"
                      >
                        Rotera / Generera ny
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
                          Klistra in din privata OpenSSH-nyckel (-----BEGIN OPENSSH PRIVATE KEY-----)
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
                          Spara privat SSH-nyckel
                        </button>
                      </form>
                    )}
                  </div>
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
                    <h3 className="text-sm font-semibold text-white">Skapa 1-klicks Invite-länk till kompisar</h3>
                    <p className="text-slate-400">
                      Skicka länken till en kompis så kan de välja sitt eget lösenord och direkt komma åt teamets delade
                      VM:ar, kluster, S3-arbetsyta och AI-minnen.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div>
                        <label className="block text-slate-400 mb-1">Roll</label>
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
                        <label className="block text-slate-400 mb-1">Max antal registreringar</label>
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
                        <label className="block text-slate-400 mb-1">Notering (valfritt)</label>
                        <input
                          type="text"
                          value={inviteNote}
                          onChange={(e) => setInviteNote(e.target.value)}
                          placeholder="t.ex. DevOps-teamet"
                          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleCreateInvite}
                      className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition"
                    >
                      Skapa & Kopiera Invite-länk
                    </button>

                    {latestInviteUrl && (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 space-y-1.5">
                        <div className="text-emerald-300 font-semibold">
                          ✓ Invite-länk skapad och kopierad till urklipp!
                        </div>
                        <div className="font-mono text-[11px] text-slate-200 break-all select-all">
                          {latestInviteUrl}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Direct user creation */}
                  <form
                    onSubmit={handleCreateUser}
                    className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-3"
                  >
                    <h3 className="text-sm font-semibold text-white">Skapa användarkonto direkt</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                      <input
                        type="text"
                        required
                        value={newUsername}
                        onChange={(e) => setNewUsername(e.target.value)}
                        placeholder="Användarnamn"
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                      />
                      <input
                        type="text"
                        value={newDisplayName}
                        onChange={(e) => setNewDisplayName(e.target.value)}
                        placeholder="Visningsnamn"
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white"
                      />
                      <input
                        type="password"
                        required
                        minLength={6}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Lösenord (min 6)"
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
                      + Lägg till användare
                    </button>
                  </form>

                  {/* Active users list */}
                  <div className="rounded-xl bg-slate-900/80 border border-slate-800 p-4 space-y-2.5">
                    <h3 className="text-sm font-semibold text-white">
                      Registrerade användare på VM:en ({usersList.length})
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
                              Ta bort
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
