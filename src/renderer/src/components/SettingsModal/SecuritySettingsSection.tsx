import React, { useId, useState } from 'react';
import { Shield, CheckCircle2, Lock, ShieldAlert, Globe } from 'lucide-react';
import { IS_WINDOWS } from '../../lib/platform';
import { pkcs11LibDisplayName } from '../../lib/smartcard';
import { WindowsAgentPathNotice } from './WindowsAgentPathNotice';
import { SshCaSettingsPanel } from './SshCaSettingsPanel';
import type { SettingsForm } from './useSettingsForm';
import { ManagedNotice } from './Managed';

/** The "Security & Smartcard" page of the settings dialog. */
export const SecuritySettingsSection: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const {
    smartcardAuthMode,
    setSmartcardAuthMode,
    smartcardUnlockAtStartup,
    setSmartcardUnlockAtStartup,
    smartcardLibPath,
    setSmartcardLibPath,
    smartcardLibs,
    setSmartcardLibs,
    detectingSmartcard,
    setDetectingSmartcard,
    credentialEncryptionAvailable,
    isManaged,
  } = form;
  // Which PIN-caching card's full explanation is expanded (§26: one sentence + "Learn more",
  // not a text wall by default) — at most one at a time.
  const [expandedCachingMode, setExpandedCachingMode] = useState<string | null>(null);
  const authModeManaged = isManaged('smartcardAuthMode');
  const authModeNoticeId = useId();

  return (
    <div className="space-y-4">
      {/* OS SafeStorage */}
      {credentialEncryptionAvailable === false ? (
        <div className="rounded-lg border border-amber-500/30 bg-app-surface p-3.5 space-y-2">
          <div className="flex items-center gap-2 text-amber-400">
            <ShieldAlert className="h-4 w-4" />
            <span className="font-semibold text-xs">Credentials are stored in plaintext</span>
          </div>
          <p className="text-xs text-txt-muted leading-relaxed">
            No OS keyring (Secret Service / KWallet / gnome-keyring, etc.) was found, so sshs3 cannot
            encrypt saved SSH and S3 credentials at rest. Any password, passphrase, or proxy password you
            save is written to disk unencrypted. Install and unlock a keyring service to enable
            encryption, or avoid saving credentials.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border-subtle bg-app-surface p-3.5 space-y-2">
          <div className="flex items-center gap-2 text-emerald-400">
            <Lock className="h-4 w-4" />
            <span className="font-semibold text-xs">
              {credentialEncryptionAvailable === null
                ? 'Checking OS keychain encryption…'
                : 'OS Keychain Encryption Active'}
            </span>
          </div>
          <p className="text-xs text-txt-muted leading-relaxed">
            All stored passwords, SSH passphrases, and S3 credentials are encrypted via Electron safeStorage
            (libsecret on Linux, DPAPI on Windows, Keychain on macOS) before persisting to disk.
          </p>
        </div>
      )}

      {/* Smartcard PIN caching */}
      <div className="space-y-2">
        <div>
          <label className="text-xs font-medium text-txt-primary">
            {IS_WINDOWS ? 'Smartcard PIN Caching' : 'Smartcard & Security Key PIN Caching'}
          </label>
          <p className="text-xs text-txt-muted">
            {IS_WINDOWS
              ? 'Applies to every Smartcard (PKCS#11) profile. FIDO2 security keys are not cached on Windows — they use a key file and ask for PIN and touch on every connection. Cached and per-terminal modes need the Windows OpenSSH Authentication Agent service to be running.'
              : 'Applies to every Smartcard (PKCS#11) and FIDO2 resident key profile.'}
          </p>
        </div>
        <div className={`grid grid-cols-1 sm:grid-cols-3 gap-2 ${authModeManaged ? 'opacity-70' : ''}`}>
          <label
            className={`flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              smartcardAuthMode === 'always-prompt'
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="smartcardAuthMode"
                disabled={authModeManaged}
                aria-describedby={authModeManaged ? authModeNoticeId : undefined}
                checked={smartcardAuthMode === 'always-prompt'}
                onChange={() => setSmartcardAuthMode('always-prompt')}
                className="sr-only"
              />
              <Lock className="h-3.5 w-3.5 text-emerald-400" />
              <span>Always Prompt (Default)</span>
            </div>
            <span className="text-xs text-txt-muted leading-tight">No caching — every connection prompts for its own PIN.</span>
            {expandedCachingMode === 'always-prompt' ? (
              <span className="text-xs text-txt-muted leading-tight">
                Every connection that needs the {IS_WINDOWS ? 'card' : 'card or security key'} (terminal, dotfiles sync) prompts for its
                own PIN. Use this if your organization requires re-authentication on every login.
              </span>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setExpandedCachingMode('always-prompt');
                }}
                className="self-start text-2xs font-medium text-sky-400 hover:underline"
              >
                Learn more
              </button>
            )}
          </label>

          <label
            className={`flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              smartcardAuthMode === 'agent-per-session'
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="smartcardAuthMode"
                disabled={authModeManaged}
                aria-describedby={authModeManaged ? authModeNoticeId : undefined}
                checked={smartcardAuthMode === 'agent-per-session'}
                onChange={() => setSmartcardAuthMode('agent-per-session')}
                className="sr-only"
              />
              <Shield className="h-3.5 w-3.5 text-sky-400" />
              <span>Once Per Terminal Connection</span>
            </div>
            <span className="text-xs text-txt-muted leading-tight">One PIN per terminal tab; cleared when it disconnects.</span>
            {expandedCachingMode === 'agent-per-session' ? (
              <span className="text-xs text-txt-muted leading-tight">
                {IS_WINDOWS
                  ? 'Enter the PIN once; the card is loaded into the Windows ssh-agent service for that terminal tab and its dotfiles sync. It is removed again as soon as that terminal disconnects — logging back in (even in the same app run) asks for the PIN again.'
                  : 'Enter the PIN once into a private, app-managed ssh-agent shared by that terminal tab and its dotfiles sync. Discarded as soon as that terminal disconnects — logging back in (even in the same app run) asks for the PIN again.'}
              </span>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setExpandedCachingMode('agent-per-session');
                }}
                className="self-start text-2xs font-medium text-sky-400 hover:underline"
              >
                Learn more
              </button>
            )}
          </label>

          <label
            className={`flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              smartcardAuthMode === 'agent-global'
                ? 'border-amber-500 bg-amber-500/15 text-amber-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="smartcardAuthMode"
                disabled={authModeManaged}
                aria-describedby={authModeManaged ? authModeNoticeId : undefined}
                checked={smartcardAuthMode === 'agent-global'}
                onChange={() => setSmartcardAuthMode('agent-global')}
                className="sr-only"
              />
              <Globe className="h-3.5 w-3.5 text-amber-400" />
              <span>Global (App Lifetime)</span>
            </div>
            <span className="text-xs text-txt-muted leading-tight">
              One PIN per {IS_WINDOWS ? 'card' : 'card or key'}, shared app-wide until you quit or lock it.
            </span>
            {expandedCachingMode === 'agent-global' ? (
              <span className="text-xs text-txt-muted leading-tight">
                Enter the PIN once per {IS_WINDOWS ? 'card' : 'card or key'}, shared by every terminal and profile using it, for as long as
                the app runs. Most convenient, least strict — anything in the app can use the {IS_WINDOWS ? 'card' : 'card/key'} until
                you quit or lock it manually below.{IS_WINDOWS ? ' On Windows the card is held by the shared ssh-agent service, so other programs using that agent can use it too.' : ' Everything unlocked lives in one app-wide ssh-agent, which local terminals use (Settings → Terminal → Local Terminal SSH Agent) — also tabs opened before you unlocked.'}
              </span>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setExpandedCachingMode('agent-global');
                }}
                className="self-start text-2xs font-medium text-sky-400 hover:underline"
              >
                Learn more
              </button>
            )}
          </label>
        </div>
        <ManagedNotice managed={authModeManaged} id={authModeNoticeId} />

        {smartcardAuthMode === 'agent-global' && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-2.5">
            <p className="text-xs text-amber-300/90 leading-tight">
              {IS_WINDOWS ? 'Cached smartcards stay' : 'Cached smartcards and security keys stay'} unlocked until the app quits. Use the lock icon in the top bar
              to lock them on demand without quitting{IS_WINDOWS ? '' : ' (the agent keeps running, so open terminals keep working once you unlock again)'}.
            </p>
            <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-txt-primary border-t border-amber-500/20 pt-2.5">
              <input
                type="checkbox"
                checked={smartcardUnlockAtStartup}
                onChange={(e) => setSmartcardUnlockAtStartup(e.target.checked)}
                className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
              />
              <span>Unlock smartcard at app startup</span>
            </label>
            <p className="text-xs text-txt-muted leading-tight pl-6">
              Prompts for the PIN as soon as the app opens instead of waiting for the first connection
              that needs it, so it's already unlocked once you get to a terminal. Uses the driver chosen
              below; with Auto-detect it only takes effect when exactly one PKCS#11 library is detected
              (or p11-kit is present).
            </p>
          </div>
        )}
      </div>

      {/* Smartcard & PKCS#11 Detection */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-txt-primary">
            Detected PKCS#11 Hardware Token Libraries
          </label>
          <button
            type="button"
            onClick={() => {
              setDetectingSmartcard(true);
              void window.multissh
                ?.smartcardDetect?.()
                ?.then((libs) => {
                  if (libs) setSmartcardLibs(libs.filter((l) => l.exists));
                })
                ?.finally(() => setDetectingSmartcard(false));
            }}
            className="text-xs text-sky-400 hover:underline"
          >
            Rescan
          </button>
        </div>

        {detectingSmartcard ? (
          <div className="py-4 text-center text-xs text-txt-muted">Scanning for PKCS#11 modules...</div>
        ) : smartcardLibs.length === 0 ? (
          <div className="rounded-lg border border-border-subtle bg-app-surface-subtle p-4 text-center text-xs text-txt-muted">
            No hardware token modules automatically detected on system paths. You can still manually specify
            a PKCS#11 library path in your SSH profiles.
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-txt-muted">
              Pick the driver used for the startup unlock, for linking Remote Profile Sync to your
              card, and as the default for any SSH profile (personal or shared via Team Vault) that
              doesn't set its own. A profile's own driver path, when set, always takes priority.
            </p>
            <WindowsAgentPathNotice libPath={smartcardLibPath} />
            {[{ path: '', name: 'Auto-detect', hint: 'Use p11-kit if present, otherwise the only detected module' }, ...smartcardLibs].map(
              (lib) => {
                const selected = smartcardLibPath === lib.path;
                const isAuto = lib.path === '';
                return (
                  <label
                    key={lib.path || 'auto'}
                    className={`flex cursor-pointer items-center justify-between rounded-lg border p-2.5 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
                      selected
                        ? 'border-sky-500 bg-sky-500/15'
                        : 'border-border-subtle bg-app-surface hover:bg-app-surface-hover'
                    }`}
                  >
                    <input
                      type="radio"
                      name="smartcardLibPath"
                      checked={selected}
                      onChange={() => setSmartcardLibPath(lib.path)}
                      className="sr-only"
                    />
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-1.5 font-medium text-txt-primary">
                        <CheckCircle2
                          className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-sky-400' : 'text-emerald-400'}`}
                        />
                        <span>{isAuto || !IS_WINDOWS ? lib.name : pkcs11LibDisplayName(lib.path)}</span>
                      </div>
                      <div
                        className="truncate font-mono text-2xs text-txt-muted"
                        title={isAuto ? undefined : lib.path}
                      >
                        {isAuto ? (lib as { hint?: string }).hint : lib.path}
                      </div>
                    </div>
                    <span
                      className={`rounded px-2 py-0.5 text-2xs font-medium shrink-0 ${
                        selected ? 'bg-sky-500/20 text-sky-300' : 'bg-sky-500/10 text-sky-400'
                      }`}
                    >
                      {selected ? 'Default' : isAuto ? 'Automatic' : 'Available'}
                    </span>
                  </label>
                );
              }
            )}
          </div>
        )}
      </div>

      {/* SSH Certificate Authorities */}
      <SshCaSettingsPanel form={form} />
    </div>
  );
};
