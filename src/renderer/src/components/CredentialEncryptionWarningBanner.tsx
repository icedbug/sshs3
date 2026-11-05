import React, { useEffect, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { plural } from '../lib/plural';

/**
 * Warns the user when the OS keyring backend (safeStorage) isn't available,
 * meaning saved SSH/S3 passwords, passphrases, and proxy passwords are being
 * written to disk in plaintext instead of encrypted (see SecretFieldCrypto's
 * fallback). Most common on Linux without libsecret/kwallet/gnome-keyring
 * running. Dismissible per app session; reappears next launch since the
 * underlying condition hasn't changed.
 *
 * Also tells the user when saved secrets exist on disk but cannot be decrypted any more (the keyring's key
 * was replaced, or the profile file came from another machine/user): they load as empty, so logins and S3 calls
 * fail without any hint why. The ciphertext cannot be recovered; the secrets have to be entered again.
 */
export const CredentialEncryptionWarningBanner: React.FC = () => {
  const [show, setShow] = useState(false);
  const [lostSecrets, setLostSecrets] = useState(0);

  useEffect(() => {
    let cancelled = false;
    window.multissh
      ?.getSecurityStatus?.()
      .then((status) => {
        if (cancelled || !status) return;
        if (status.credentialEncryptionAvailable === false) {
          setShow(true);
        } else if (status.undecryptableSecretCount > 0) {
          setLostSecrets(status.undecryptableSecretCount);
          setShow(true);
        }
      })
      .catch(() => {
        // If the check itself fails, fail open (no banner) rather than
        // nagging the user based on an inconclusive result.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <div
      role="alert"
      data-testid="credential-encryption-warning-banner"
      className="fixed top-3 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 rounded-xl border border-amber-500/30 bg-app-card shadow-2xl animate-in fade-in slide-in-from-top-2 duration-150"
    >
      <div className="flex items-start gap-2.5 p-3.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
          <ShieldAlert className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          {lostSecrets > 0 ? (
            <>
              <p className="text-sm font-medium text-txt-primary">
                {plural(lostSecrets, 'saved secret')} could not be decrypted
              </p>
              <p className="mt-0.5 text-xs text-txt-secondary">
                They load as empty, so logins and S3 requests will fail. If your OS keyring was locked or not
                ready when sshs3 started, unlock it and restart sshs3: they may come back. If the keyring key
                was replaced or reset they cannot be recovered: open each affected profile in the Connection
                Manager and enter the secret again.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-txt-primary">Saved passwords are not encrypted</p>
              <p className="mt-0.5 text-xs text-txt-secondary">
                No OS keyring (Secret Service / KWallet / gnome-keyring, etc.) was found, so sshs3 cannot
                encrypt saved SSH and S3 credentials at rest. Any password, passphrase, or proxy password
                you save will be stored in plaintext in your profile file. Install and unlock a keyring
                service to enable encryption, or avoid saving credentials.
              </p>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShow(false)}
          className="shrink-0 rounded-md p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
