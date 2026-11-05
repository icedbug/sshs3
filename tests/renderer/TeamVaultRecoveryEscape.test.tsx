// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal/SettingsModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import { DEFAULT_SETTINGS } from '../../src/shared/types/settings';

// The recovery key is shown once. Escape used to reach the Settings modal underneath (the recovery dialog was
// not in the Escape stack), which closed Settings and threw the key away with its panel state.
describe('Team Vault recovery key dialog inside Settings', () => {
  afterEach(() => cleanup());

  function mockApi() {
    const explicit: Record<string, unknown> = {
      settingsGet: vi.fn().mockResolvedValue({}),
      teamVaultList: vi.fn().mockResolvedValue([]),
      teamVaultEnrollRecipient: vi.fn().mockResolvedValue({
        recipient: 'age1yubikey1testadmin',
        identityFilePath: '/tmp/identity.txt',
      }),
      teamVaultCreate: vi.fn().mockResolvedValue({
        vaultId: 'vlt_new',
        recoveryIdentity: 'AGE-SECRET-KEY-FAKE\n# public key: age1x',
      }),
      teamVaultGetStatus: vi.fn().mockResolvedValue({
        exists: true,
        vaultId: 'vlt_new',
        unlocked: true,
        filePath: '/x',
        members: [],
        adminCount: 1,
      }),
    };
    // Anything else: subscriptions (onXxx) return an unsubscribe function, calls resolve to undefined.
    window.multissh = new Proxy(explicit, {
      get: (target, prop: string) => {
        if (prop in target) return target[prop];
        return /^on[A-Z]/.test(prop) ? vi.fn(() => () => undefined) : vi.fn().mockResolvedValue(undefined);
      },
    }) as unknown as typeof window.multissh;
  }

  async function openRecoveryDialog(onClose: () => void) {
    mockApi();
    render(
      <ConfirmProvider>
        <SettingsModal open currentSettings={DEFAULT_SETTINGS} onSave={vi.fn()} onClose={onClose} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole('tab', { name: /Team Vault/ }));
    await waitFor(() => expect(screen.getByText(/No Team Vault has been set up/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Create a new team/i }));
    fireEvent.click(screen.getByRole('button', { name: /Generate my Team Vault ID/i }));
    await waitFor(() => expect(screen.getByText('age1yubikey1testadmin')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/alice@piv/i), { target: { value: 'alice@piv:yubikey-1' } });
    fireEvent.change(screen.getByPlaceholderText(/Acme Infra Team/i), { target: { value: 'Acme Infra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    return screen.findByRole('dialog', { name: 'Save your recovery key' });
  }

  it('does not let Escape close Settings or the recovery dialog before the key is saved', async () => {
    const onClose = vi.fn();
    const dialog = await openRecoveryDialog(onClose);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Save your recovery key' })).toBe(dialog);
    expect(dialog).toHaveTextContent('AGE-SECRET-KEY-FAKE');
  });

  it('moves focus into the recovery dialog and keeps Tab inside it', async () => {
    const dialog = await openRecoveryDialog(vi.fn());

    expect(dialog.contains(document.activeElement)).toBe(true);
    const buttons = within(dialog).getAllByRole('button');
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('stops swallowing Escape once the key is saved: it backs out of the new vault, then closes Settings', async () => {
    const onClose = vi.fn();
    const dialog = await openRecoveryDialog(onClose);

    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Save your recovery key' })).not.toBeInTheDocument();

    // Done opens the new vault's detail view, which owns the first Escape (back to the list).
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
