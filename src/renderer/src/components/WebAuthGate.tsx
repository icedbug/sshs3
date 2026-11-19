import React, { useEffect, useState, useCallback, useRef } from 'react';
import { copyToClipboard } from '../lib/clipboard';
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
import { ROLES_ON_A_SERVER, sharingText } from '@shared/sharingText';

/** What an invited teammate shares on this server and what stays theirs: the same words as in the AI settings. */
const INVITE_SHARING = sharingText({ server: true, bucket: false }, 'each');

const WEB_AUTH_COPY = {
  workspaceBadge: 'sshs3 Multi-User Web Workspace',
  vmServer: 'VM Server',
  connecting: 'Connecting to the sshs3 web workspace…',
  setupTitle: 'Create the admin account (first start)',
  inviteTitle: 'Join the team workspace',
  loginTitle: 'Sign in to sshs3',
  setupDesc:
    'Welcome. Create the administrator account for this server. You get a personal SSH key and can invite your team with a link.',
  inviteDesc:
    "Create your own account. You get your own SSH key on the server. With everyone on this server you share the team's servers, Workforce board, agents, Knowledge Base and team memory. Your model key, sign-ins and conversations stay yours.",
  loginDesc: "Sign in to open your own terminal tabs and work in the team's shared workspace.",
  stepAdmin: '1. Admin account',
  stepAdminDesc: 'Create your account below',
  stepKey: '2. Your own SSH key',
  stepKeyDesc: 'Generated for you',
  stepInvite: '3. Invite the team',
  stepInviteDesc: 'Share an invite link',
  usernameForSignIn: 'User name (for signing in)',
  displayNameTeam: 'Display name in the team',
  passwordMin6: 'Password (at least 6 characters)',
  creatingAdminBtn: 'Creating admin and SSH key…',
  createAdminBtn: 'Create the admin account and start sshs3',
  inviteAcceptedTitle: '✓ Invite link accepted.',
  inviteAcceptedBody: 'Choose your user name and password below.',
  changeCode: 'Change code',
  inviteCode: 'Invite code',
  inviteCodePlaceholder: 'Paste the invite code…',
  chooseUsername: 'Choose a user name',
  yourDisplayName: 'Your display name in the team',
  choosePassword: 'Choose a password (at least 6 characters)',
  creatingMemberBtn: 'Creating account and SSH key…',
  joinTeamBtn: 'Join the team and open the workspace',
  alreadyAccount: 'Already have an account? Sign in here',
  usernameLabel: 'User name',
  passwordLabel: 'Password',
  signingInBtn: 'Signing in…',
  signInBtn: 'Sign in',
  gotInviteLink: 'Got an invite code from a teammate? Join here',
  ssoDivider: 'or',
  signInWithSso: (provider: string) => `Sign in with ${provider}`,
  liveUp: 'Live connection is up',
  reconnecting: 'Reconnecting…',
  sshKeyPill: '🔑 SSH key',
  inviteTeamPill: '👥 Invite / team',
  signedInServer: 'Signed in to the sshs3 web server',
  signOut: 'Sign out',
  close: 'Close',
  tabSsh: '🔑 My SSH key on the server',
  tabTeam: '👥 Invites and user accounts',
  welcomePrefix: 'Welcome,',
  onboardKeyDesc: 'has been created on the server.',
  copySshKey: '🔑 Copy my public SSH key',
  copiedSshKey: '✓ SSH key copied',
  inviteTeammates: '👥 Invite teammates',
  changePasswordHeading: 'Change password',
  currentPasswordPlaceholder: 'Current password',
  newPasswordPlaceholder: 'New password (at least 6 characters)',
  updatePasswordBtn: 'Update password',
  passwordUpdatedMsg: 'The password was updated',
  revokeBtn: 'Revoke',
  errSetup: 'Could not create the admin account',
  errLogin: 'Wrong user name or password',
  errInvite: 'The invite code could not be used',
  errAdminLoad: 'Could not load the admin data',
} as const;

export interface WebAuthGateProps {
  children: React.ReactNode;
  onSsoLogin?: (url: string) => void;
}

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

interface AuthStatusResponse {
  initialized: boolean;
  authenticated: boolean;
  user: WebUserPublic | null;
  wsTicket?: string;
  publicUrl?: string;
  ssoConfigured?: boolean;
  oidcConfigured?: boolean;
  ssoUrl?: string;
  ssoProviderName?: string;
  sso?: boolean | { enabled?: boolean; loginUrl?: string; label?: string; providerName?: string };
}

export function isLocalOrPrivateUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  let host: string;
  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
    const parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);
    host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    const withoutScheme = trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    const authority = withoutScheme.split('/')[0].toLowerCase();
    const bracketMatch = /^\[([^\]]+)\](?::\d+)?$/.exec(authority);
    const unbracketed = bracketMatch ? bracketMatch[1] : authority.replace(/^\[|\]$/g, '');
    if (unbracketed.includes(':')) {
      host = unbracketed;
    } else {
      return false;
    }
  }
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local')) {
    return true;
  }
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(host)) return true;
  const m172 = /^172\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  const bareV6 = host.split('%')[0];
  if (bareV6 === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(bareV6)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(bareV6)) return true;
  return false;
}

function validateInviteBaseUrl(raw: string): { valid: boolean; normalized: string; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      valid: false,
      normalized: '',
      error: 'Enter a valid http:// or https:// server address, or click Reset.',
    };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        valid: false,
        normalized: '',
        error: 'The server address must start with http:// or https://.',
      };
    }
    if (!parsed.hostname) {
      return {
        valid: false,
        normalized: '',
        error: 'Enter a valid server host name or IP address.',
      };
    }
    return {
      valid: true,
      normalized: trimmed.replace(/\/+$/, ''),
      error: '',
    };
  } catch {
    return {
      valid: false,
      normalized: '',
      error: 'Enter a valid server address (for example https://sshs3.example.com).',
    };
  }
}

interface AuthSuccessResponse {
  token?: string;
  sessionToken?: string;
  wsTicket?: string;
  user: WebUserPublic;
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

export const WebAuthGate: React.FC<WebAuthGateProps> = ({ children, onSsoLogin }) => {
  const inWebMode = isWebBrowserMode();

  const t = WEB_AUTH_COPY;

  const [loading, setLoading] = useState<boolean>(inWebMode);
  const [initialized, setInitialized] = useState<boolean>(true);
  const [authenticated, setAuthenticated] = useState<boolean>(false);
  const [user, setUser] = useState<WebUserPublic | null>(null);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [ssoConfig, setSsoConfig] = useState<{ enabled: boolean; url: string; label: string }>({
    enabled: false,
    url: '/api/auth/sso/login',
    label: 'SSO',
  });

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
  const [copyError, setCopyError] = useState<string | null>(null);
  const [customPrivateKey, setCustomPrivateKey] = useState('');
  const [showImportKey, setShowImportKey] = useState(false);
  const [keyStatusMsg, setKeyStatusMsg] = useState<string | null>(null);
  const [currentPasswordInput, setCurrentPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [passwordStatusMsg, setPasswordStatusMsg] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const modalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasModalOpenRef = useRef(false);

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
  const [serverPublicUrl, setServerPublicUrl] = useState<string>('');
  const [inviteBaseUrl, setInviteBaseUrl] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.origin : '',
  );
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);
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
    const ssoError = params.get('sso_error') || params.get('error');
    if (ssoError) {
      setAuthError(ssoError);
    }

    const unsubWs = onWebConnectionStateChange((connected) => {
      setWsConnected(connected);
    });

    webApiFetch<AuthStatusResponse>('/api/auth/status')
      .then((status) => {
        setInitialized(status.initialized);
        if (status.publicUrl) {
          setServerPublicUrl(status.publicUrl);
          setInviteBaseUrl(status.publicUrl);
        }
        const ssoObj = typeof status.sso === 'object' && status.sso ? status.sso : null;
        const ssoEnabled = Boolean(
          status.ssoConfigured || status.oidcConfigured || status.ssoUrl || status.sso === true || ssoObj?.enabled
        );
        setSsoConfig({
          enabled: ssoEnabled,
          url: status.ssoUrl || ssoObj?.loginUrl || '/api/auth/sso/login',
          label: status.ssoProviderName || ssoObj?.label || ssoObj?.providerName || 'SSO',
        });

        if (status.authenticated && status.user && !urlInvite) {
          connectWebClientBridge(status.wsTicket || getStoredWebSessionToken() || null);
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
      setAdminMsg(err?.message || t.errAdminLoad);
    }
  }, [user, t.errAdminLoad]);

  useEffect(() => {
    if (showModal && modalTab === 'team' && user?.role === 'admin') {
      loadAdminData();
    }
  }, [showModal, modalTab, user, loadAdminData]);

  useEffect(() => {
    if (showModal) {
      wasModalOpenRef.current = true;
      modalRef.current?.focus();
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setShowModal(false);
        }
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    } else if (wasModalOpenRef.current) {
      wasModalOpenRef.current = false;
      modalTriggerRef.current?.focus();
    }
  }, [showModal]);

  if (!inWebMode) {
    return <>{children}</>;
  }

  const handleCopyText = async (text: string, label: string): Promise<boolean> => {
    setCopyError(null);
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedText(label);
      window.setTimeout(() => setCopiedText(null), 2400);
      return true;
    }
    setCopiedText(null);
    setCopyError(label);
    window.setTimeout(() => setCopyError((cur) => (cur === label ? null : cur)), 4000);
    return false;
  };

  const handleAuthSuccess = (
    token: string | undefined,
    loggedInUser: WebUserPublic,
    isFirstTime = false,
    wsTicket?: string
  ) => {
    if (token) {
      setStoredWebSessionToken(token);
    } else {
      setStoredWebSessionToken(null);
    }
    connectWebClientBridge(wsTicket || token || null);
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
      const res = await webApiFetch<AuthSuccessResponse>('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
          password,
        }),
      });
      handleAuthSuccess(res.token || res.sessionToken, res.user, true, res.wsTicket);
    } catch (err: any) {
      setAuthError(err?.message || t.errSetup);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setSubmitting(true);
    try {
      const res = await webApiFetch<AuthSuccessResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });
      handleAuthSuccess(res.token || res.sessionToken, res.user, false, res.wsTicket);
    } catch (err: any) {
      setAuthError(err?.message || t.errLogin);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSsoLogin = () => {
    setAuthError(null);
    if (onSsoLogin) {
      onSsoLogin(ssoConfig.url);
      return;
    }
    window.location.assign(ssoConfig.url);
  };

  const handleRedeemInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setSubmitting(true);
    try {
      const res = await webApiFetch<AuthSuccessResponse>('/api/auth/register-invite', {
        method: 'POST',
        body: JSON.stringify({
          inviteToken: inviteToken.trim(),
          username: username.trim(),
          displayName: displayName.trim() || username.trim(),
          password,
        }),
      });
      handleAuthSuccess(res.token || res.sessionToken, res.user, true, res.wsTicket);
    } catch (err: any) {
      setAuthError(err?.message || t.errInvite);
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

  const defaultInviteBase = serverPublicUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  const inviteBaseValidation = validateInviteBaseUrl(inviteBaseUrl);
  const effectiveInviteBaseUrl = inviteBaseValidation.valid
    ? inviteBaseValidation.normalized
    : defaultInviteBase.replace(/\/+$/, '');
  const inviteUsesLocalAddress = inviteBaseValidation.valid && isLocalOrPrivateUrl(effectiveInviteBaseUrl);

  const handleCreateInvite = async () => {
    if (!inviteBaseValidation.valid) return;
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
      const url = `${effectiveInviteBaseUrl}/?invite=${res.invite.token}`;
      setLatestInviteUrl(url);
      setLatestInviteCopied(false);
      const copied = await handleCopyText(url, 'invite-url');
      setLatestInviteCopied(copied);
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
      setPasswordStatusMsg(t.passwordUpdatedMsg);
    } catch (err: any) {
      setPasswordStatusMsg(`Error: ${err?.message || 'Could not change the password'}`);
    }
  };

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="min-h-screen w-full bg-[#090d16] text-slate-100 flex items-center justify-center"
      >
        <div className="flex flex-col items-center gap-3">
          <div className="w-9 h-9 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
          <div className="text-sm text-slate-400 font-mono">{t.connecting}</div>
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
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-medium">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                {t.workspaceBadge}
              </div>
              <span className="text-[11px] font-mono text-slate-500">{t.vmServer}</span>
            </div>

            <h1 className="text-xl font-bold text-white tracking-tight pt-1">
              {!initialized ? t.setupTitle : authMode === 'invite' ? t.inviteTitle : t.loginTitle}
            </h1>
            <p className="text-xs text-slate-400 leading-relaxed">
              {!initialized ? t.setupDesc : authMode === 'invite' ? t.inviteDesc : t.loginDesc}
            </p>
          </div>

          {!initialized && (
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-cyan-300">{t.stepAdmin}</div>
                <div className="text-slate-400 mt-0.5">{t.stepAdminDesc}</div>
              </div>
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-emerald-300">{t.stepKey}</div>
                <div className="text-slate-400 mt-0.5">{t.stepKeyDesc}</div>
              </div>
              <div className="rounded-lg bg-slate-900/90 border border-slate-800 p-2.5">
                <div className="font-semibold text-indigo-300">{t.stepInvite}</div>
                <div className="text-slate-400 mt-0.5">{t.stepInviteDesc}</div>
              </div>
            </div>
          )}

          {authError && (
            <div
              role="alert"
              className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3.5 py-2.5 text-xs text-rose-300"
            >
              {authError}
            </div>
          )}

          {!initialized ? (
            <form onSubmit={handleInitialSetup} className="space-y-4">
              <div>
                <label htmlFor="web-auth-setup-username" className="block text-xs font-medium text-slate-300 mb-1">
                  {t.usernameForSignIn}
                </label>
                <input
                  id="web-auth-setup-username"
                  type="text"
                  required
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. jacob"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                />
              </div>
              <div>
                <label htmlFor="web-auth-setup-display" className="block text-xs font-medium text-slate-300 mb-1">
                  {t.displayNameTeam}
                </label>
                <input
                  id="web-auth-setup-display"
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Jacob (Admin)"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                />
              </div>
              <div>
                <label htmlFor="web-auth-setup-password" className="block text-xs font-medium text-slate-300 mb-1">
                  {t.passwordMin6}
                </label>
                <input
                  id="web-auth-setup-password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold py-2.5 text-sm transition shadow-lg shadow-cyan-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                {submitting ? t.creatingAdminBtn : t.createAdminBtn}
              </button>
            </form>
          ) : authMode === 'invite' ? (
            <form onSubmit={handleRedeemInvite} className="space-y-4">
              {inviteFromUrl && inviteToken && !showRawInviteInput ? (
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 flex items-center justify-between gap-2">
                  <div className="text-xs text-emerald-200">
                    <span className="font-semibold text-emerald-300">{t.inviteAcceptedTitle}</span> {t.inviteAcceptedBody}
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowRawInviteInput(true)}
                    className="text-[11px] text-emerald-300 hover:underline shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded"
                  >
                    {t.changeCode}
                  </button>
                </div>
              ) : (
                <div>
                  <label htmlFor="web-auth-invite-code" className="block text-xs font-medium text-slate-300 mb-1">
                    {t.inviteCode}
                  </label>
                  <input
                    id="web-auth-invite-code"
                    type="text"
                    required
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    placeholder={t.inviteCodePlaceholder}
                    className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white font-mono focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                  />
                </div>
              )}
              <div>
                <label htmlFor="web-auth-invite-username" className="block text-xs font-medium text-slate-300 mb-1">
                  {t.chooseUsername}
                </label>
                <input
                  id="web-auth-invite-username"
                  type="text"
                  required
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. erik"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                />
              </div>
              <div>
                <label htmlFor="web-auth-invite-display" className="block text-xs font-medium text-slate-300 mb-1">
                  {t.yourDisplayName}
                </label>
                <input
                  id="web-auth-invite-display"
                  type="text"
                  autoComplete="name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Erik"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                />
              </div>
              <div>
                <label htmlFor="web-auth-invite-password" className="block text-xs font-medium text-slate-300 mb-1">
                  {t.choosePassword}
                </label>
                <input
                  id="web-auth-invite-password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold py-2.5 text-sm transition shadow-lg shadow-cyan-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                {submitting ? t.creatingMemberBtn : t.joinTeamBtn}
              </button>
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError(null);
                  }}
                  className="text-xs text-cyan-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded"
                >
                  {t.alreadyAccount}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="web-auth-login-username" className="block text-xs font-medium text-slate-300 mb-1">
                  {t.usernameLabel}
                </label>
                <input
                  id="web-auth-login-username"
                  type="text"
                  required
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t.usernameLabel}
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                />
              </div>
              <div>
                <label htmlFor="web-auth-login-password" className="block text-xs font-medium text-slate-300 mb-1">
                  {t.passwordLabel}
                </label>
                <input
                  id="web-auth-login-password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-slate-900/90 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus:border-cyan-400"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold py-2.5 text-sm transition shadow-lg shadow-cyan-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                {submitting ? t.signingInBtn : t.signInBtn}
              </button>
              {ssoConfig.enabled && (
                <div className="space-y-2.5 pt-1">
                  <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="h-px flex-1 bg-slate-800" />
                    <span>{t.ssoDivider}</span>
                    <span className="h-px flex-1 bg-slate-800" />
                  </div>
                  <button
                    type="button"
                    data-testid="web-auth-sso-btn"
                    onClick={handleSsoLogin}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-100 font-medium py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                  >
                    {t.signInWithSso(ssoConfig.label)}
                  </button>
                </div>
              )}
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('invite');
                    setAuthError(null);
                  }}
                  className="text-xs text-cyan-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 rounded"
                >
                  {t.gotInviteLink}
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
    <div className="web-auth-shell flex h-screen w-screen flex-col overflow-hidden">
      {/* Compact docked web account & workspace bar (kept out of bottom-right terminal HUD) */}
      <header
        data-testid="web-auth-topbar"
        className="web-auth-topbar flex h-8 shrink-0 items-center justify-between border-b border-slate-800/80 bg-slate-950/90 px-3 text-xs text-slate-200"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-2 h-2 shrink-0 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`}
            title={wsConnected ? t.liveUp : t.reconnecting}
            aria-label={wsConnected ? t.liveUp : t.reconnecting}
          />
          <span className="truncate font-medium text-slate-200">{user?.displayName || user?.username}</span>
          <span className="hidden sm:inline text-[11px] font-mono text-slate-400">(@{user?.username})</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            ref={modalTriggerRef}
            type="button"
            onClick={() => {
              setModalTab('ssh');
              setShowModal(true);
            }}
            className="px-2.5 py-0.5 rounded-full bg-slate-800 hover:bg-slate-700 text-[11px] text-cyan-300 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            {t.sshKeyPill}
          </button>
          {user?.role === 'admin' && (
            <button
              type="button"
              onClick={() => {
                setModalTab('team');
                setShowModal(true);
              }}
              className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/30 text-[11px] text-cyan-200 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              {t.inviteTeamPill}
            </button>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden [&>*]:!h-full">{children}</div>

      {/* Onboarding Quick-Start Banner right after creating account / joining team */}
      {justOnboarded && user && !showModal && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-10 right-3 z-[9991] w-full max-w-md rounded-2xl border border-cyan-500/40 bg-[#0f1624]/95 p-4 shadow-2xl backdrop-blur space-y-3 text-xs text-slate-200"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-white flex items-center gap-1.5">
                <span>
                  🎉 {t.welcomePrefix} {user.displayName}
                </span>
              </div>
              <p className="text-slate-400 mt-0.5 leading-relaxed">
                <code className="text-cyan-300">ssh-ed25519</code> {t.onboardKeyDesc}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setJustOnboarded(false)}
              aria-label="Dismiss"
              className="text-slate-400 hover:text-white px-1.5 py-0.5 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleCopyText(user.sshPublicKey, 'onboard-key')}
              className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              {copiedText === 'onboard-key' ? t.copiedSshKey : t.copySshKey}
            </button>
            {user.role === 'admin' && (
              <button
                type="button"
                onClick={() => {
                  setModalTab('team');
                  setShowModal(true);
                  setJustOnboarded(false);
                }}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-cyan-300 font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              >
                {t.inviteTeammates}
              </button>
            )}
          </div>
          {copyError === 'onboard-key' && (
            <div role="status" className="text-amber-300 text-[11px]">
              Could not copy automatically. Open your SSH key and copy the text.
            </div>
          )}
        </div>
      )}

      {/* Web Account, SSH Key & Team Admin Modal */}
      {showModal && user && (
        <div
          className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowModal(false);
          }}
        >
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="web-auth-modal-title"
            tabIndex={-1}
            className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-[#0f1624] text-slate-100 shadow-2xl overflow-hidden flex flex-col max-h-[88vh] focus:outline-none"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-300 font-bold text-sm">
                  {(user.displayName || user.username).slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div id="web-auth-modal-title" className="text-sm font-semibold text-white flex items-center gap-2">
                    {user.displayName}
                    <span className="text-[11px] font-mono text-slate-400">(@{user.username})</span>
                  </div>
                  <div className="text-[11px] text-slate-400">{t.signedInServer}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                >
                  {t.signOut}
                </button>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                >
                  {t.close}
                </button>
              </div>
            </div>

            {/* Tabs */}
            <div role="tablist" className="flex border-b border-slate-800 px-5 bg-slate-950/40">
              <button
                type="button"
                role="tab"
                aria-selected={modalTab === 'ssh'}
                onClick={() => setModalTab('ssh')}
                className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                  modalTab === 'ssh'
                    ? 'border-cyan-400 text-cyan-300'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.tabSsh}
              </button>
              {user.role === 'admin' && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={modalTab === 'team'}
                  onClick={() => setModalTab('team')}
                  className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${
                    modalTab === 'team'
                      ? 'border-cyan-400 text-cyan-300'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.tabTeam}
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
                        onClick={() => void handleCopyText(user.sshPublicKey, 'pubkey')}
                        className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold transition"
                      >
                        {copiedText === 'pubkey' ? '✓ Copied' : 'Copy public SSH key'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleCopyText(authorizedKeysCmd, 'authcmd')}
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

                    {(copyError === 'pubkey' || copyError === 'authcmd') && (
                      <div role="status" data-testid="ssh-copy-error" className="text-amber-300 text-[11px]">
                        Could not copy automatically. Select and copy the text.
                      </div>
                    )}

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
                    <h3 className="text-sm font-semibold text-white">{t.changePasswordHeading}</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="password"
                        required
                        aria-label={t.currentPasswordPlaceholder}
                        value={currentPasswordInput}
                        onChange={(e) => setCurrentPasswordInput(e.target.value)}
                        placeholder={t.currentPasswordPlaceholder}
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                      />
                      <input
                        type="password"
                        required
                        minLength={6}
                        aria-label={t.newPasswordPlaceholder}
                        value={newPasswordInput}
                        onChange={(e) => setNewPasswordInput(e.target.value)}
                        placeholder={t.newPasswordPlaceholder}
                        className="rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                      />
                    </div>
                    <button
                      type="submit"
                      className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                    >
                      {t.updatePasswordBtn}
                    </button>
                    {passwordStatusMsg && (
                      <div role="status" className="rounded-lg bg-cyan-500/10 border border-cyan-500/30 px-3 py-2 text-cyan-200">
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
                      Send the link to a teammate. They choose their own user name and password and get an account on
                      this server.
                    </p>
                    <p className="text-slate-400" data-testid="invite-sharing">
                      {INVITE_SHARING.shared} {INVITE_SHARING.personal} {INVITE_SHARING.more}
                    </p>
                    <p className="text-slate-400" data-testid="invite-roles">
                      {ROLES_ON_A_SERVER}
                    </p>
                    <div>
                      <label className="block text-slate-400 mb-1" htmlFor="invite-base-url-input">
                        Server address for invite links
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id="invite-base-url-input"
                          data-testid="invite-base-url"
                          type="url"
                          value={inviteBaseUrl}
                          onChange={(e) => setInviteBaseUrl(e.target.value)}
                          placeholder="https://sshs3.example.com"
                          className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-white font-mono text-[11px]"
                        />
                        {inviteBaseUrl.trim() !== defaultInviteBase && (
                          <button
                            type="button"
                            onClick={() => setInviteBaseUrl(defaultInviteBase)}
                            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] shrink-0"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    </div>
                    {!inviteBaseValidation.valid && (
                      <div
                        role="alert"
                        data-testid="invite-base-url-error"
                        className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-rose-300 text-[11px]"
                      >
                        {inviteBaseValidation.error}
                      </div>
                    )}
                    {inviteUsesLocalAddress && (
                      <div
                        role="status"
                        data-testid="invite-local-warning"
                        className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-amber-200 text-[11px]"
                      >
                        This address is local or private ({effectiveInviteBaseUrl}). Teammates on other machines cannot
                        open it unless you enter your public server URL above or set <code>SSHS3_PUBLIC_URL</code> on the
                        server.
                      </div>
                    )}
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
                      disabled={!inviteBaseValidation.valid}
                      onClick={() => void handleCreateInvite()}
                      className="px-3.5 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold transition"
                    >
                      Create and copy invite link
                    </button>

                    {latestInviteUrl && (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 space-y-1.5">
                        <div className="text-emerald-300 font-semibold">
                          {latestInviteCopied
                            ? '✓ Invite link created and copied to the clipboard'
                            : '✓ Invite link created'}
                        </div>
                        {!latestInviteCopied && (
                          <div role="status" data-testid="invite-copy-error" className="text-amber-300 text-[11px]">
                            Could not copy automatically. Select and copy the text.
                          </div>
                        )}
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
                            const invUrl = `${effectiveInviteBaseUrl}/?invite=${inv.token}`;
                            return (
                              <div key={inv.token} className="py-2 flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-mono text-[11px] text-cyan-200 truncate">
                                    {inv.token}
                                    {inv.note ? ` · ${inv.note}` : ''}
                                  </div>
                                  <div className="text-[10px] text-slate-400">
                                    Role: {inv.role} · Used: {inv.usedCount ?? inv.uses ?? 0}/{inv.maxUses}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() => void handleCopyText(invUrl, `inv-${inv.token}`)}
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
                        {copyError?.startsWith('inv-') && (
                          <div role="status" data-testid="invite-copy-error" className="text-amber-300 text-[11px]">
                            Could not copy automatically. Select and copy the text.
                          </div>
                        )}
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
    </div>
  );
};
