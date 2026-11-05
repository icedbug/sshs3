// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SmartcardPinModal } from '../../src/renderer/src/components/SmartcardPinModal';

describe('SmartcardPinModal Component', () => {
  let promptCallback:
    | ((event: { id: string; prompt: string; sessionId?: string; kind?: 'smartcard' | 'fido2' }) => void)
    | null = null;
  let presenceClearCallback: ((event: { id?: string; sessionId?: string }) => void) | null = null;
  const mockUnsubscribeAskpass = vi.fn();
  const mockUnsubscribePresenceClear = vi.fn();
  const mockSubmitAskpassPin = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    presenceClearCallback = null;
    promptCallback = null;
    mockUnsubscribeAskpass.mockClear();
    mockUnsubscribePresenceClear.mockClear();
    mockSubmitAskpassPin.mockClear();

    // Mock window.multissh
    window.multissh = {
      ...(window.multissh || {}),
      onAskpassPrompt: vi.fn((cb) => {
        promptCallback = cb;
        return mockUnsubscribeAskpass;
      }),
      onPresenceClear: vi.fn((cb) => {
        presenceClearCallback = cb;
        return mockUnsubscribePresenceClear;
      }),
      submitAskpassPin: mockSubmitAskpassPin,
    } as any;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there is no active prompt', () => {
    render(<SmartcardPinModal />);
    expect(screen.queryByTestId('smartcard-pin-modal')).not.toBeInTheDocument();
  });

  it('renders modal with prompt text and password field when prompt is received', () => {
    render(<SmartcardPinModal />);

    expect(window.multissh.onAskpassPrompt).toHaveBeenCalled();

    // Trigger prompt
    act(() => {
      promptCallback!({
        id: 'askpass-1',
        prompt: "Enter PIN for 'Net iD PKCS#11':",
      });
    });

    expect(screen.getByTestId('smartcard-pin-modal')).toBeInTheDocument();
    expect(screen.getByText("Enter PIN for 'Net iD PKCS#11':")).toBeInTheDocument();

    const input = screen.getByTestId('smartcard-pin-input') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('password');
  });

  it('puts focus in the PIN field as soon as the prompt appears, even from another element, and keeps Tab inside', () => {
    const terminal = document.createElement('textarea');
    document.body.appendChild(terminal);
    terminal.focus();
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({ id: 'askpass-focus', prompt: "Enter PIN for 'Net iD PKCS#11':" });
    });

    const input = screen.getByTestId('smartcard-pin-input');
    expect(input).toHaveFocus();

    const dialog = screen.getByTestId('smartcard-pin-modal');
    const buttons = dialog.querySelectorAll('button');
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    terminal.remove();
  });

  it('submits PIN and closes modal when OK button is clicked or Enter is pressed', async () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-2',
        prompt: 'Enter PIN for smartcard:',
      });
    });

    const input = screen.getByTestId('smartcard-pin-input');
    fireEvent.change(input, { target: { value: '123456' } });

    const submitBtn = screen.getByTestId('smartcard-pin-submit');
    fireEvent.click(submitBtn);

    expect(mockSubmitAskpassPin).toHaveBeenCalledTimes(1);
    expect(mockSubmitAskpassPin).toHaveBeenCalledWith('askpass-2', '123456');

    // Modal should close
    expect(screen.queryByTestId('smartcard-pin-modal')).not.toBeInTheDocument();
  });

  it('submits PIN when Enter key is pressed in the input field', async () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-enter',
        prompt: 'Enter PIN for key:',
      });
    });

    const input = screen.getByTestId('smartcard-pin-input');
    fireEvent.change(input, { target: { value: '9876' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(mockSubmitAskpassPin).toHaveBeenCalledWith('askpass-enter', '9876');
    expect(screen.queryByTestId('smartcard-pin-modal')).not.toBeInTheDocument();
  });

  it('cancels and submits empty PIN when Cancel button or Escape key is pressed', () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-cancel',
        prompt: 'Enter PIN:',
      });
    });

    const cancelBtn = screen.getByTestId('smartcard-pin-cancel');
    fireEvent.click(cancelBtn);

    expect(mockSubmitAskpassPin).toHaveBeenCalledTimes(1);
    expect(mockSubmitAskpassPin).toHaveBeenCalledWith('askpass-cancel', '');
    expect(screen.queryByTestId('smartcard-pin-modal')).not.toBeInTheDocument();

    // Trigger another prompt and test Escape key
    act(() => {
      promptCallback!({
        id: 'askpass-esc',
        prompt: 'Enter PIN 2:',
      });
    });

    const input = screen.getByTestId('smartcard-pin-input');
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });

    expect(mockSubmitAskpassPin).toHaveBeenCalledWith('askpass-esc', '');
    expect(screen.queryByTestId('smartcard-pin-modal')).not.toBeInTheDocument();
  });

  // M11 (code review): this modal can appear while focus is still inside a
  // terminal (before the input's own delayed focus() call runs, or if focus
  // moves back out), so Escape must be caught window-wide.
  it('responds to Escape even when it is dispatched on document.body, not the dialog (M11)', () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-esc-body',
        prompt: 'Enter PIN 3:',
      });
    });

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

    expect(mockSubmitAskpassPin).toHaveBeenCalledWith('askpass-esc-body', '');
    expect(screen.queryByTestId('smartcard-pin-modal')).not.toBeInTheDocument();
  });

  it('cleans up askpass listener on unmount', () => {
    const { unmount } = render(<SmartcardPinModal />);
    unmount();

    expect(mockUnsubscribeAskpass).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribePresenceClear).toHaveBeenCalledTimes(1);
  });

  it('labels the modal as FIDO2 when the prompt carries kind "fido2"', () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-fido2',
        prompt: "Enter PIN for authenticator:",
        kind: 'fido2',
      });
    });

    expect(screen.getByText('FIDO2 / Security Key Authentication')).toBeInTheDocument();
    expect(screen.queryByText('Smartcard / PIV Authentication')).not.toBeInTheDocument();
  });

  it('labels the modal as Smartcard/PIV when the prompt carries kind "smartcard"', () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-smartcard',
        prompt: "Enter PIN for 'PIV_II':",
        kind: 'smartcard',
      });
    });

    expect(screen.getByText('Smartcard / PIV Authentication')).toBeInTheDocument();
    expect(screen.queryByText('FIDO2 / Security Key Authentication')).not.toBeInTheDocument();
  });

  it('shows a touch hint when the agent\'s own prompt asks to confirm user presence', () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-presence',
        prompt: 'Enter PIN and confirm user presence for ED25519-SK key SHA256:abc123: ',
        kind: 'fido2',
      });
    });

    expect(screen.getByText(/Touch your security key after submitting/i)).toBeInTheDocument();
  });

  it('does not show a touch hint for a plain PIN prompt with no presence requirement', () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-plain',
        prompt: 'Enter PIN for authenticator: ',
        kind: 'fido2',
      });
    });

    expect(screen.queryByText(/Touch your security key after submitting/i)).not.toBeInTheDocument();
  });

  it('falls back to generic wording when the prompt carries no kind', () => {
    render(<SmartcardPinModal />);

    act(() => {
      promptCallback!({
        id: 'askpass-generic',
        prompt: 'Enter passphrase:',
      });
    });

    expect(screen.getByText('Security Authentication')).toBeInTheDocument();
  });

  describe('the lingering "touch now" banner after submit', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('appears after submitting a presence-needing prompt, even though the modal itself closes', async () => {
      render(<SmartcardPinModal />);

      act(() => {
        promptCallback!({
          id: 'askpass-presence',
          prompt: 'Enter PIN and confirm user presence for ED25519-SK key SHA256:abc123: ',
          kind: 'fido2',
        });
      });

      const input = screen.getByTestId('smartcard-pin-input');
      fireEvent.change(input, { target: { value: '123456' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('smartcard-pin-submit'));
      });

      expect(screen.queryByTestId('smartcard-pin-modal')).not.toBeInTheDocument();
      expect(screen.getByTestId('smartcard-awaiting-touch-banner')).toBeInTheDocument();
      expect(screen.getByText(/Touch your security key now/i)).toBeInTheDocument();
    });

    it('does not appear for a plain PIN prompt with no presence requirement', async () => {
      render(<SmartcardPinModal />);

      act(() => {
        promptCallback!({ id: 'askpass-plain', prompt: 'Enter PIN for authenticator: ' });
      });

      fireEvent.change(screen.getByTestId('smartcard-pin-input'), { target: { value: '123456' } });
      await act(async () => {
        fireEvent.click(screen.getByTestId('smartcard-pin-submit'));
      });

      expect(screen.queryByTestId('smartcard-awaiting-touch-banner')).not.toBeInTheDocument();
    });

    it('auto-clears on its own after the timeout', async () => {
      render(<SmartcardPinModal />);

      act(() => {
        promptCallback!({
          id: 'askpass-presence',
          prompt: 'Confirm user presence for key ED25519-SK SHA256:abc123',
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('smartcard-pin-submit'));
      });
      expect(screen.getByTestId('smartcard-awaiting-touch-banner')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(screen.queryByTestId('smartcard-awaiting-touch-banner')).not.toBeInTheDocument();
    });

    it('is cleared early by onPresenceClear event for matching session', async () => {
      render(<SmartcardPinModal />);

      act(() => {
        promptCallback!({
          id: 'askpass-presence',
          sessionId: 'session-42',
          prompt: 'Confirm user presence for key ED25519-SK SHA256:abc123',
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('smartcard-pin-submit'));
      });
      expect(screen.getByTestId('smartcard-awaiting-touch-banner')).toBeInTheDocument();

      // Presence clear event arrives for matching session
      act(() => {
        presenceClearCallback!({ sessionId: 'session-42' });
      });

      expect(screen.queryByTestId('smartcard-awaiting-touch-banner')).not.toBeInTheDocument();
    });

    it('is cleared early by a new incoming prompt rather than lingering underneath it', async () => {
      render(<SmartcardPinModal />);

      act(() => {
        promptCallback!({ id: 'askpass-presence-1', prompt: 'Confirm user presence for key ED25519-SK SHA256:abc123' });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('smartcard-pin-submit'));
      });
      expect(screen.getByTestId('smartcard-awaiting-touch-banner')).toBeInTheDocument();

      act(() => {
        promptCallback!({ id: 'askpass-next', prompt: 'Enter PIN for PKCS#11 token: ', kind: 'smartcard' });
      });

      expect(screen.queryByTestId('smartcard-awaiting-touch-banner')).not.toBeInTheDocument();
    });

    it('survives a second touch-needing prompt arriving right behind the first, instead of being wiped before it can be seen', async () => {
      // Regression test for the real-world sequence reported: "Confirm user presence for key ..."
      // immediately followed by "Enter PIN and confirm user presence for ... key ...: " — both
      // need touch, and the second one used to race the first submission's reset effect, clearing
      // the banner in the same tick it appeared so it was never actually visible on screen.
      render(<SmartcardPinModal />);

      act(() => {
        promptCallback!({ id: 'askpass-presence-1', prompt: 'Confirm user presence for key ED25519-SK SHA256:abc123' });
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('smartcard-pin-submit'));
      });
      expect(screen.getByTestId('smartcard-awaiting-touch-banner')).toBeInTheDocument();

      // The second presence prompt arrives immediately after, before the user has done anything else.
      act(() => {
        promptCallback!({
          id: 'askpass-presence-2',
          prompt: 'Enter PIN and confirm user presence for ED25519-SK key SHA256:abc123: ',
        });
      });

      expect(screen.getByTestId('smartcard-awaiting-touch-banner')).toBeInTheDocument();
      expect(screen.getByTestId('smartcard-pin-modal')).toBeInTheDocument();
    });
  });
});
