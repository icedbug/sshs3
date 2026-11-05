import React from 'react';
import { SmartcardPinModal } from './SmartcardPinModal';
import { InsertTokenModal } from './InsertTokenModal';
import { TouchPresenceBanner } from './TouchPresenceBanner';
import { HostKeyTrustModal } from './HostKeyTrustModal';
import { AwsSsoLoginModal } from './AwsSsoLoginModal';
import { TransferConflictModal } from './TransferConflictModal';
import { QuitConfirmBridge } from './QuitConfirmBridge';
import { DotfilesSyncBanner } from './DotfilesSyncBanner';
import { UpdateBanner } from './UpdateBanner';
import { CredentialEncryptionWarningBanner } from './CredentialEncryptionWarningBanner';
import { SmartcardStartupUnlockBanner } from './SmartcardStartupUnlockBanner';

/** App-wide prompts and banners driven by main-process events; none of them take props. */
export const GlobalOverlays: React.FC = () => (
  <>
    {/* Global Smartcard PIN Modal */}
    <SmartcardPinModal />

    {/* Global "insert your smartcard / security key" prompt; gives way to the PIN modal once detected */}
    <InsertTokenModal />

    {/* Global "touch your YubiKey/smartcard" banner */}
    <TouchPresenceBanner />

    {/* Global SFTP host key trust-on-first-use dialog */}
    <HostKeyTrustModal />

    {/* Global AWS SSO device-authorization login dialog */}
    <AwsSsoLoginModal />

    {/* Global transfer conflict (overwrite/skip/rename) dialog */}
    <TransferConflictModal />
    <QuitConfirmBridge />

    {/* Top-right notices share one column so two of them showing at once stack instead of overlapping */}
    <div className="pointer-events-none fixed top-3 right-3 z-50 flex w-full max-w-sm flex-col gap-2 [&>*]:pointer-events-auto">
      {/* Surfaces a wrong/missing PIN from smartcardUnlockAtStartup, which otherwise fails silently */}
      <SmartcardStartupUnlockBanner />
      {/* Global dotfiles pool sync prompt (opt-in feature, see Settings) */}
      <DotfilesSyncBanner />
    </div>

    {/* New-version notice (poll against GitHub Releases, user-driven download/install) */}
    <UpdateBanner />

    {/* Warns if saved credentials can't be OS-keyring-encrypted and are falling back to plaintext */}
    <CredentialEncryptionWarningBanner />
  </>
);
