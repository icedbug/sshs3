// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AwsSsoLoginModal } from '../../src/renderer/src/components/AwsSsoLoginModal';
import type { AwsSsoPromptEvent } from '../../src/shared/types/ipc';

describe('AwsSsoLoginModal Component', () => {
  let promptCallback: ((event: AwsSsoPromptEvent) => void) | null = null;
  let doneCallback: ((id: string) => void) | null = null;
  const mockUnsubscribe = vi.fn();
  const mockCancel = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    promptCallback = null;
    mockUnsubscribe.mockClear();
    mockCancel.mockClear();

    window.multissh = {
      ...(window.multissh || {}),
      onAwsSsoPrompt: vi.fn((cb) => {
        promptCallback = cb;
        return mockUnsubscribe;
      }),
      onAwsSsoPromptDone: vi.fn((cb) => {
        doneCallback = cb;
        return vi.fn();
      }),
      awsSsoCancelLogin: mockCancel,
    } as any;
  });

  afterEach(() => {
    cleanup();
  });

  it('closes by itself when the login attempt ends', () => {
    render(<AwsSsoLoginModal />);
    act(() => {
      promptCallback!({ id: 'sso-1', userCode: 'ABCD-1234', verificationUri: 'https://x.awsapps.com/device', expiresIn: 600 });
    });
    expect(screen.getByTestId('aws-sso-login-modal')).toBeInTheDocument();

    act(() => doneCallback!('sso-1'));
    expect(screen.queryByTestId('aws-sso-login-modal')).not.toBeInTheDocument();
  });

  it('renders nothing when there is no active prompt', () => {
    render(<AwsSsoLoginModal />);
    expect(screen.queryByTestId('aws-sso-login-modal')).not.toBeInTheDocument();
  });

  it('shows the device code and verification URI for an active prompt', () => {
    render(<AwsSsoLoginModal />);

    act(() => {
      promptCallback!({
        id: 'sso-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://example.awsapps.com/device',
        verificationUriComplete: 'https://example.awsapps.com/device?user_code=ABCD-1234',
        expiresIn: 600,
      });
    });

    expect(screen.getByTestId('aws-sso-login-modal')).toBeInTheDocument();
    expect(screen.getByText('ABCD-1234')).toBeInTheDocument();
    expect(screen.getByText('https://example.awsapps.com/device')).toBeInTheDocument();
  });

  it('cancels the login via the Cancel button', () => {
    render(<AwsSsoLoginModal />);

    act(() => {
      promptCallback!({
        id: 'sso-2',
        userCode: 'EFGH-5678',
        verificationUri: 'https://example.awsapps.com/device',
        expiresIn: 600,
      });
    });

    fireEvent.click(screen.getByTestId('aws-sso-login-cancel'));

    expect(mockCancel).toHaveBeenCalledWith('sso-2');
    expect(screen.queryByTestId('aws-sso-login-modal')).not.toBeInTheDocument();
  });

  it('cancels the login on Escape', () => {
    render(<AwsSsoLoginModal />);

    act(() => {
      promptCallback!({
        id: 'sso-3',
        userCode: 'IJKL-9012',
        verificationUri: 'https://example.awsapps.com/device',
        expiresIn: 600,
      });
    });

    fireEvent.keyDown(screen.getByTestId('aws-sso-login-modal'), { key: 'Escape', code: 'Escape' });

    expect(mockCancel).toHaveBeenCalledWith('sso-3');
    expect(screen.queryByTestId('aws-sso-login-modal')).not.toBeInTheDocument();
  });

  // M11 (code review): Escape must be caught window-wide, not only when
  // dispatched at (or bubbled up from) the dialog element itself, since
  // this modal can appear while focus is still elsewhere (e.g. a terminal).
  it('cancels the login on Escape even when dispatched on document.body, not the dialog (M11)', () => {
    render(<AwsSsoLoginModal />);

    act(() => {
      promptCallback!({
        id: 'sso-4',
        userCode: 'MNOP-3456',
        verificationUri: 'https://example.awsapps.com/device',
        expiresIn: 600,
      });
    });

    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });

    expect(mockCancel).toHaveBeenCalledWith('sso-4');
    expect(screen.queryByTestId('aws-sso-login-modal')).not.toBeInTheDocument();
  });

  it('cleans up the AWS SSO prompt listener on unmount', () => {
    const { unmount } = render(<AwsSsoLoginModal />);
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
