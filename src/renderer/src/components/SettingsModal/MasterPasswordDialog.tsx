import React, { useEffect, useRef, useState } from 'react';
import { KeyRound, AlertTriangle, Loader2, X } from 'lucide-react';
import { estimatePasswordStrength, MIN_ACCEPTABLE_SCORE, type PasswordStrength } from './passwordStrength';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

const INITIAL_STRENGTH: PasswordStrength = { score: 0, label: 'Very weak', colorClassName: 'bg-red-500' };

/**
 * Scores `password` via the lazily-loaded zxcvbn-ts (see passwordStrength.ts)
 * whenever it changes. `loaded` is false until the first real score for the
 * *current* password has resolved — canSubmit below treats that as "not yet
 * known" rather than "weak", so a slow/failed dynamic import can only ever
 * be as permissive as the old length-only check, never block a password
 * before it's actually been scored.
 */
function usePasswordStrength(password: string): PasswordStrength & { loaded: boolean } {
  const [state, setState] = useState<PasswordStrength & { loaded: boolean }>({ ...INITIAL_STRENGTH, loaded: false });

  useEffect(() => {
    if (!password) {
      setState({ ...INITIAL_STRENGTH, loaded: false });
      return;
    }
    let cancelled = false;
    void estimatePasswordStrength(password).then((result) => {
      if (!cancelled) setState({ ...result, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, [password]);

  return state;
}

function meetsStrengthRequirement(password: string, strength: PasswordStrength & { loaded: boolean }): boolean {
  if (password.length < 8) return false;
  if (!strength.loaded) return true;
  return strength.score >= MIN_ACCEPTABLE_SCORE;
}

function StrengthTooWeakHint({
  password,
  strength,
}: {
  password: string;
  strength: PasswordStrength & { loaded: boolean };
}): React.ReactElement | null {
  if (password.length < 8 || !strength.loaded || strength.score >= MIN_ACCEPTABLE_SCORE) return null;
  return (
    <p className="text-2xs text-red-400">
      Too easy to guess (common word, pattern, or reused elsewhere) — try something longer or less predictable.
    </p>
  );
}

export interface MasterPasswordDialogProps {
  open: boolean;
  /**
   * 'setup' = first-time activation: both passwords must be entered twice
   * (there is no recovery if one is mistyped and forgotten), with a
   * strength meter and an explicit warning. 'unlock' = re-entering already
   * chosen passwords (re-enable after a restart, or bootstrapping a new
   * machine) — single entry each, no strength meter.
   */
  mode: 'setup' | 'unlock';
  title: string;
  description?: string;
  submitLabel: string;
  submitting?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (
    passwords: { topologyPassword: string; credentialsPassword: string },
    options?: { linkSmartcard?: boolean }
  ) => void;
  onUnlockWithSmartcard?: () => void;
  canLinkSmartcard?: boolean;
}

let passwordFieldIdCounter = 0;

function PasswordField({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const [id] = useState(() => `master-password-field-${++passwordFieldIdCounter}`);
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-txt-primary">
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 text-xs text-txt-primary outline-none focus:border-sky-500"
      />
    </div>
  );
}

export const MasterPasswordDialog: React.FC<MasterPasswordDialogProps> = ({
  open,
  mode,
  title,
  description,
  submitLabel,
  submitting,
  error,
  onCancel,
  onSubmit,
  onUnlockWithSmartcard,
  canLinkSmartcard,
}) => {
  const [separatePasswords, setSeparatePasswords] = useState(false);
  const [singlePassword, setSinglePassword] = useState('');
  const [singleConfirm, setSingleConfirm] = useState('');
  const [topologyPassword, setTopologyPassword] = useState('');
  const [topologyConfirm, setTopologyConfirm] = useState('');
  const [credentialsPassword, setCredentialsPassword] = useState('');
  const [credentialsConfirm, setCredentialsConfirm] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [linkSmartcard, setLinkSmartcard] = useState(false);

  useEffect(() => {
    if (open) {
      setSeparatePasswords(false);
      setSinglePassword('');
      setSingleConfirm('');
      setTopologyPassword('');
      setTopologyConfirm('');
      setCredentialsPassword('');
      setCredentialsConfirm('');
      setAcknowledged(false);
      setLinkSmartcard(Boolean(canLinkSmartcard));
    }
  }, [open, canLinkSmartcard]);

  // Hooks must run on every render regardless of `open` — the early return
  // below happens after these.
  const singleStrength = usePasswordStrength(singlePassword);
  const topologyStrength = usePasswordStrength(topologyPassword);
  const credentialsStrength = usePasswordStrength(credentialsPassword);

  // Escape closes; a stray backdrop click would discard typed input, so it is intentionally ignored.
  useModalDismiss(onCancel, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  if (!open) return null;

  const isSetup = mode === 'setup';

  // In single-password mode:
  const singleMismatch = isSetup && singleConfirm.length > 0 && singlePassword !== singleConfirm;
  const singleCanSubmit =
    singlePassword.length > 0 &&
    (!isSetup ||
      (singlePassword === singleConfirm && acknowledged && meetsStrengthRequirement(singlePassword, singleStrength)));

  // In separate-passwords mode:
  const topologyMismatch = isSetup && topologyConfirm.length > 0 && topologyPassword !== topologyConfirm;
  const credentialsMismatch = isSetup && credentialsConfirm.length > 0 && credentialsPassword !== credentialsConfirm;
  const separateCanSubmit =
    topologyPassword.length > 0 &&
    credentialsPassword.length > 0 &&
    (!isSetup ||
      (topologyPassword === topologyConfirm &&
        credentialsPassword === credentialsConfirm &&
        acknowledged &&
        meetsStrengthRequirement(topologyPassword, topologyStrength) &&
        meetsStrengthRequirement(credentialsPassword, credentialsStrength)));

  const canSubmit = separatePasswords ? separateCanSubmit : singleCanSubmit;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const passwords = separatePasswords
      ? { topologyPassword, credentialsPassword }
      : { topologyPassword: singlePassword, credentialsPassword: singlePassword };
    onSubmit(passwords, { linkSmartcard: Boolean(canLinkSmartcard && linkSmartcard) });
  };

  // This dialog can be rendered from within a page that's itself inside a
  // <form> (e.g. the Settings modal's Save Settings form), so it uses a
  // plain <div> + onKeyDown instead of a nested <form> — nested forms are
  // invalid HTML and would submit the wrong one.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/65 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} className="flex w-full max-w-md flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-divider bg-app-surface px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
              <KeyRound className="h-4 w-4" />
            </div>
            <h2 className="text-sm font-semibold text-txt-primary">{title}</h2>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onCancel}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div onKeyDown={handleKeyDown} className="flex flex-col">
          <div className="space-y-4 p-5 text-xs text-txt-secondary max-h-[70vh] overflow-y-auto">
            {description && <p className="text-xs text-txt-muted leading-relaxed">{description}</p>}

            {/* Mode toggle / info */}
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs font-medium text-txt-primary">
                {separatePasswords ? 'Separate passwords (Advanced)' : 'Single master password'}
              </span>
              <button
                type="button"
                onClick={() => setSeparatePasswords((prev) => !prev)}
                className="text-xs text-sky-400 hover:underline"
              >
                {separatePasswords ? 'Switch to single password' : 'Use separate passwords'}
              </button>
            </div>

            {!separatePasswords ? (
              <div className="space-y-2">
                <PasswordField
                  label="Master password"
                  value={singlePassword}
                  onChange={setSinglePassword}
                  autoFocus
                />
                <p className="text-2xs text-txt-muted">
                  {isSetup
                    ? 'Protects both connection profiles and saved credentials with strong Zero-Knowledge encryption.'
                    : 'Enter your master password to unlock sync for this session.'}
                </p>
                {isSetup && singlePassword && (
                  <div className="flex items-center gap-2">
                    <div className="h-1 flex-1 rounded-full bg-app-surface overflow-hidden">
                      <div
                        className={`h-full ${singleStrength.colorClassName} transition-all`}
                        style={{ width: `${(singleStrength.score + 1) * 20}%` }}
                      />
                    </div>
                    <span className="text-2xs text-txt-muted w-16 shrink-0">{singleStrength.label}</span>
                  </div>
                )}
                {isSetup && singlePassword && <StrengthTooWeakHint password={singlePassword} strength={singleStrength} />}
                {isSetup && (
                  <PasswordField
                    label="Confirm master password"
                    value={singleConfirm}
                    onChange={setSingleConfirm}
                  />
                )}
                {singleMismatch && <p className="text-2xs text-red-400">Passwords don't match.</p>}
              </div>
            ) : (
              <>
                {/* Topology password */}
                <div className="space-y-2">
                  <PasswordField label="Topology master password" value={topologyPassword} onChange={setTopologyPassword} autoFocus />
                  <p className="text-2xs text-txt-muted">
                    Protects server names, hostnames, ports, and configuration structure.
                  </p>
                  {isSetup && topologyPassword && (
                    <div className="flex items-center gap-2">
                      <div className="h-1 flex-1 rounded-full bg-app-surface overflow-hidden">
                        <div
                          className={`h-full ${topologyStrength.colorClassName} transition-all`}
                          style={{ width: `${(topologyStrength.score + 1) * 20}%` }}
                        />
                      </div>
                      <span className="text-2xs text-txt-muted w-16 shrink-0">{topologyStrength.label}</span>
                    </div>
                  )}
                  {isSetup && topologyPassword && (
                    <StrengthTooWeakHint password={topologyPassword} strength={topologyStrength} />
                  )}
                  {isSetup && (
                    <PasswordField label="Confirm topology master password" value={topologyConfirm} onChange={setTopologyConfirm} />
                  )}
                  {topologyMismatch && <p className="text-2xs text-red-400">Passwords don't match.</p>}
                </div>

                {/* Credentials password */}
                <div className="space-y-2 pt-2 border-t border-divider">
                  <PasswordField label="Credentials master password" value={credentialsPassword} onChange={setCredentialsPassword} />
                  <p className="text-2xs text-txt-muted">
                    Protects usernames, saved passwords, private keys, and API tokens.
                  </p>
                  {isSetup && credentialsPassword && (
                    <div className="flex items-center gap-2">
                      <div className="h-1 flex-1 rounded-full bg-app-surface overflow-hidden">
                        <div
                          className={`h-full ${credentialsStrength.colorClassName} transition-all`}
                          style={{ width: `${(credentialsStrength.score + 1) * 20}%` }}
                        />
                      </div>
                      <span className="text-2xs text-txt-muted w-16 shrink-0">{credentialsStrength.label}</span>
                    </div>
                  )}
                  {isSetup && credentialsPassword && (
                    <StrengthTooWeakHint password={credentialsPassword} strength={credentialsStrength} />
                  )}
                  {isSetup && (
                    <PasswordField
                      label="Confirm credentials master password"
                      value={credentialsConfirm}
                      onChange={setCredentialsConfirm}
                    />
                  )}
                  {credentialsMismatch && <p className="text-2xs text-red-400">Passwords don't match.</p>}
                </div>
              </>
            )}

            {isSetup && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-1.5">
                  <p className="text-xs text-amber-200 leading-relaxed">
                    These passwords are never sent anywhere and never stored. If you lose either one, the data
                    encrypted with it can <strong>never</strong> be recovered — not by you, and not by us.
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={(e) => setAcknowledged(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
                    />
                    <span className="text-xs text-amber-200">I've saved these passwords somewhere safe.</span>
                  </label>
                </div>
              </div>
            )}

            {canLinkSmartcard && (
              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={linkSmartcard}
                  onChange={(e) => setLinkSmartcard(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
                />
                <span className="text-xs text-txt-secondary flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 text-sky-400" />
                  <span>Link smartcard (allow unlocking with card PIN in the future)</span>
                </span>
              </label>
            )}

            {error && (
              <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-300">{error}</div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-divider bg-app-surface px-5 py-3">
            {mode === 'unlock' && onUnlockWithSmartcard ? (
              <button
                type="button"
                onClick={() => {
                  onCancel();
                  onUnlockWithSmartcard();
                }}
                className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/20 transition-colors"
              >
                <KeyRound className="h-3.5 w-3.5 text-sky-400" />
                <span>Unlock with Smartcard</span>
              </button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit || submitting}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {submitLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MasterPasswordDialog;
