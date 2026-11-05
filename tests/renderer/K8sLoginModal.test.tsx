// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { K8sLoginModal } from '../../src/renderer/src/components/K8s/K8sLoginModal';
import type { K8sWebLoginResult } from '../../src/shared/types/kubernetes';

const loginResult: K8sWebLoginResult = {
  success: true,
  contextName: 'team-a/api/alice',
  clusterName: 'api',
  userName: 'alice/api',
  server: 'https://api.cluster.example.com:6443',
  namespace: 'team-a',
  projects: ['team-a'],
};

const SERVER = 'https://api.cluster.example.com:6443';

describe('K8sLoginModal browser sign-in', () => {
  const probe = vi.fn();
  const webLogin = vi.fn();
  const webLoginCancel = vi.fn();
  const pasteLogin = vi.fn();
  const profilesSave = vi.fn();
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    probe.mockReset().mockResolvedValue({ supported: false });
    webLogin.mockReset().mockResolvedValue(loginResult);
    webLoginCancel.mockReset().mockResolvedValue(undefined);
    pasteLogin.mockReset().mockResolvedValue(loginResult);
    profilesSave.mockReset().mockImplementation(async (p) => p);
    onClose.mockReset();
    onSuccess.mockReset();
    window.multissh = {
      ...(window.multissh || {}),
      k8sOpenShiftProbe: probe,
      k8sOpenShiftWebLogin: webLogin,
      k8sOpenShiftWebLoginCancel: webLoginCancel,
      k8sLogin: pasteLogin,
      k8sProfilesSave: profilesSave,
    } as never;
  });

  afterEach(() => cleanup());

  const renderModal = (open = true) => render(<K8sLoginModal open={open} onClose={onClose} onSuccess={onSuccess} />);
  const tokenLabel = () => screen.getByText(/API Token/, { selector: 'label' });
  const waitForBrowserOption = async () => {
    const option = await screen.findByRole('radio', { name: /sign in with browser/i });
    await waitFor(() => expect(option).toBeEnabled(), { timeout: 3000 });
    return option;
  };
  const typeServer = (value = SERVER) =>
    fireEvent.change(screen.getByLabelText('API server URL'), { target: { value } });

  it('keeps the paste flow only when the cluster has no OpenShift OAuth server', async () => {
    renderModal();
    typeServer();
    await waitFor(() => expect(probe).toHaveBeenCalledWith(SERVER, false), { timeout: 3000 });
    expect(screen.queryByTestId('openshift-web-login')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Paste oc login command')).toBeInTheDocument();
  });

  it('always shows the switch, with browser sign-in disabled until a server is entered', () => {
    renderModal();
    expect(screen.getByRole('radiogroup', { name: 'Sign-in method' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /sign in with browser/i })).toBeDisabled();
    expect(screen.getByText(/Enter the server URL to check/)).toBeInTheDocument();
  });

  it('marks the token as required for the paste flow when browser sign-in is not available', async () => {
    renderModal();
    typeServer();
    await waitFor(() => expect(probe).toHaveBeenCalled(), { timeout: 3000 });
    expect(screen.getByLabelText('Token')).toBeRequired();
    expect(within(tokenLabel()).getByText('*')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /sign in with browser/i })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /use a token/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Browser sign-in is not available for this cluster/)).toBeInTheDocument();
  });

  it('offers a choice and defaults to browser sign-in, hiding the token form, once the cluster supports it', async () => {
    probe.mockResolvedValue({ supported: true });
    renderModal();
    typeServer();
    const browserOption = await waitForBrowserOption();
    expect(browserOption).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /use a token/i })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('openshift-web-login')).toBeInTheDocument();
    expect(screen.queryByLabelText('Token')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Paste oc login command')).not.toBeInTheDocument();
  });

  it('shows only the token form after choosing to use a token', async () => {
    probe.mockResolvedValue({ supported: true });
    renderModal();
    typeServer();
    await waitForBrowserOption();

    fireEvent.click(screen.getByRole('radio', { name: /use a token/i }));
    expect(screen.getByLabelText('Token')).toBeRequired();
    expect(screen.getByLabelText('Paste oc login command')).toBeInTheDocument();
    expect(screen.queryByTestId('openshift-web-login')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in & connect/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in with browser$/i })).not.toBeInTheDocument();
  });

  it('requires a token for the token submit even when browser sign-in is available', async () => {
    probe.mockResolvedValue({ supported: true });
    renderModal();
    typeServer();
    await waitForBrowserOption();
    fireEvent.click(screen.getByRole('radio', { name: /use a token/i }));

    fireEvent.submit(screen.getByLabelText('API server URL').closest('form')!);
    expect(await screen.findByText('Token is required')).toBeInTheDocument();
    expect(pasteLogin).not.toHaveBeenCalled();
  });

  it('switches to the token form when an oc login command is pasted', async () => {
    probe.mockResolvedValue({ supported: true });
    renderModal();
    typeServer();
    await waitForBrowserOption();
    fireEvent.click(screen.getByRole('radio', { name: /use a token/i }));
    fireEvent.change(screen.getByLabelText('Paste oc login command'), {
      target: { value: `oc login --token=sha256~pasted --server=${SERVER}` },
    });
    expect(screen.getByRole('radio', { name: /use a token/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Token')).toHaveValue('sha256~pasted');
  });

  it('does not probe while closed or before a server is entered', async () => {
    renderModal(false);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(probe).not.toHaveBeenCalled();
  });

  it('signs in with the browser, remembers the cluster as a profile and closes', async () => {
    probe.mockResolvedValue({ supported: true });
    renderModal();
    typeServer();
    fireEvent.change(screen.getByLabelText('Default project / namespace'), { target: { value: 'team-a' } });

    const button = await screen.findByRole('button', { name: /^sign in with browser$/i }, { timeout: 3000 });
    fireEvent.click(button);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(loginResult));
    expect(webLogin).toHaveBeenCalledWith({ server: SERVER, insecureSkipTlsVerify: false, namespace: 'team-a' });
    expect(profilesSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'api.cluster.example.com',
        server: SERVER,
        namespace: 'team-a',
        contextName: 'team-a/api/alice',
      })
    );
    expect(onClose).toHaveBeenCalled();
    expect(pasteLogin).not.toHaveBeenCalled();
  });

  it('does not save a profile when "Save as profile" is unchecked', async () => {
    probe.mockResolvedValue({ supported: true });
    renderModal();
    typeServer();
    fireEvent.click(screen.getByLabelText('Save as profile'));
    fireEvent.click(await screen.findByRole('button', { name: /^sign in with browser$/i }, { timeout: 3000 }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(profilesSave).not.toHaveBeenCalled();
  });

  it('prefills from a saved profile and updates that same profile on sign-in', async () => {
    probe.mockResolvedValue({ supported: false });
    const profile = { id: 'p1', name: 'Prod', server: SERVER, namespace: 'team-a', insecureSkipTlsVerify: true };
    render(<K8sLoginModal open onClose={onClose} onSuccess={onSuccess} initialProfile={profile} />);

    expect(screen.getByLabelText('API server URL')).toHaveValue(SERVER);
    expect(screen.getByLabelText('Default project / namespace')).toHaveValue('team-a');
    expect(screen.getByLabelText('Profile name')).toHaveValue('Prod');

    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'sha256~new' } });
    fireEvent.click(screen.getByRole('button', { name: /log in & connect/i }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(profilesSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', name: 'Prod', namespace: 'team-a', insecureSkipTlsVerify: true })
    );
  });

  it('updates the saved profile of the same server and project instead of adding a second one', async () => {
    probe.mockResolvedValue({ supported: true });
    const existing = { id: 'p1', name: 'Prod', server: SERVER, namespace: 'team-a', contextName: 'team-a/api/alice' };
    (window.multissh as unknown as { k8sProfilesList: unknown }).k8sProfilesList = vi.fn().mockResolvedValue([
      { id: 'other', name: 'Other', server: 'https://other.example.com:6443' },
      existing,
    ]);
    renderModal();
    typeServer();
    fireEvent.change(screen.getByLabelText('Default project / namespace'), { target: { value: 'team-a' } });
    fireEvent.click(await screen.findByRole('button', { name: /^sign in with browser$/i }, { timeout: 3000 }));

    await waitFor(() => expect(profilesSave).toHaveBeenCalled());
    // The name field was left blank, so the saved profile keeps its own name.
    expect(profilesSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', name: 'Prod', namespace: 'team-a' }));
  });

  it('adds a new profile when the project differs from the saved one for that server', async () => {
    probe.mockResolvedValue({ supported: true });
    (window.multissh as unknown as { k8sProfilesList: unknown }).k8sProfilesList = vi
      .fn()
      .mockResolvedValue([{ id: 'p1', name: 'Prod', server: SERVER, namespace: 'team-a' }]);
    renderModal();
    typeServer();
    fireEvent.change(screen.getByLabelText('Default project / namespace'), { target: { value: 'team-b' } });
    fireEvent.click(await screen.findByRole('button', { name: /^sign in with browser$/i }, { timeout: 3000 }));

    await waitFor(() => expect(profilesSave).toHaveBeenCalled());
    const saved = profilesSave.mock.calls[0][0] as { id: string };
    expect(saved.id).not.toBe('p1');
  });

  it('starts the browser sign-in with Enter in the server field', async () => {
    probe.mockResolvedValue({ supported: true });
    renderModal();
    typeServer();
    await waitForBrowserOption();

    fireEvent.submit(screen.getByLabelText('API server URL').closest('form')!);
    await waitFor(() => expect(webLogin).toHaveBeenCalledTimes(1));
    expect(pasteLogin).not.toHaveBeenCalled();
  });

  it('shows the error and keeps the paste fields when browser sign-in fails', async () => {
    probe.mockResolvedValue({ supported: true });
    webLogin.mockRejectedValue(new Error("Error invoking remote method 'k8s:openshift-web-login': Error: Timed out waiting for the browser sign-in."));
    renderModal();
    typeServer();
    fireEvent.click(await screen.findByRole('button', { name: /^sign in with browser$/i }, { timeout: 3000 }));

    expect(await screen.findByText('Timed out waiting for the browser sign-in.')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText('API server URL')).toHaveValue(SERVER);
    expect(profilesSave).not.toHaveBeenCalled();
  });

  it('cancels a pending sign-in with Escape instead of closing the dialog, silently', async () => {
    probe.mockResolvedValue({ supported: true });
    let reject!: (err: Error) => void;
    webLogin.mockReturnValue(new Promise((_resolve, rej) => (reject = rej)));
    renderModal();
    typeServer();
    fireEvent.click(await screen.findByRole('button', { name: /^sign in with browser$/i }, { timeout: 3000 }));
    await screen.findByText(/Waiting for browser sign-in/);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(webLoginCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    reject(new Error('OpenShift browser sign-in was cancelled'));
    await waitFor(() => expect(screen.queryByText(/Waiting for browser sign-in/)).not.toBeInTheDocument());
    expect(screen.queryByText(/was cancelled/)).not.toBeInTheDocument();

    // With nothing pending, Escape closes the dialog as before.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still logs in with a pasted token', async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('Paste oc login command'), {
      target: { value: `oc login --token=sha256~pasted --server=${SERVER}` },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in & connect/i }));

    await waitFor(() => expect(pasteLogin).toHaveBeenCalled());
    expect(pasteLogin).toHaveBeenCalledWith(expect.objectContaining({ server: SERVER, token: 'sha256~pasted' }));
    expect(webLogin).not.toHaveBeenCalled();
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(loginResult));
  });
});
