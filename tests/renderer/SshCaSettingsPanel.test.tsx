// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SshCaSettingsPanel } from '../../src/renderer/src/components/SettingsModal/SshCaSettingsPanel';
import type { SettingsForm } from '../../src/renderer/src/components/SettingsModal/useSettingsForm';
import type { SshCaConfig } from '../../src/shared/types/sshCa';

describe('SshCaSettingsPanel', () => {
  let configs: SshCaConfig[];
  let defaultId: string | undefined;
  const mockSetConfigs = vi.fn((newConfigs) => {
    configs = newConfigs;
  });
  const mockSetDefaultId = vi.fn((id) => {
    defaultId = id;
  });

  const mockLogin = vi.fn();

  beforeEach(() => {
    configs = [];
    defaultId = undefined;
    vi.clearAllMocks();

    window.sshs3 = {
      ...window.sshs3,
      sshCaGetStatus: vi.fn().mockResolvedValue({ active: false }),
      onSshCaStatusChanged: vi.fn().mockReturnValue(() => {}),
      sshCaLogin: mockLogin,
      sshCaLogout: vi.fn().mockResolvedValue(undefined),
      sshCaRenew: vi.fn().mockResolvedValue({ active: true }),
    } as any;
  });

  const createMockForm = (overrides: Partial<SettingsForm> = {}): SettingsForm => {
    return {
      sshCaConfigs: configs,
      setSshCaConfigs: mockSetConfigs,
      defaultSshCaConfigId: defaultId,
      setDefaultSshCaConfigId: mockSetDefaultId,
      ...overrides,
    } as unknown as SettingsForm;
  };

  it('renders empty placeholder when no CAs configured', () => {
    render(<SshCaSettingsPanel form={createMockForm()} />);
    expect(
      screen.getByText(/No SSH Certificate Authorities configured yet/i)
    ).toBeInTheDocument();
  });

  it('opens add form, creates new CA configuration, and saves', () => {
    render(<SshCaSettingsPanel form={createMockForm()} />);

    fireEvent.click(screen.getByTestId('add-ssh-ca-btn'));
    expect(screen.getByText('New SSH CA')).toBeInTheDocument();

    const nameInput = screen.getByPlaceholderText('Step-CA Internal');
    fireEvent.change(nameInput, { target: { value: 'Production Step-CA' } });

    const caUrlInput = screen.getByPlaceholderText('https://ca.example.com:30900');
    fireEvent.change(caUrlInput, { target: { value: 'https://ca.prod.corp:30900' } });

    const oidcUrlInput = screen.getByPlaceholderText('https://keycloak.example.com/realms/sshca');
    fireEvent.change(oidcUrlInput, { target: { value: 'https://idp.prod.corp/realms/ssh' } });

    fireEvent.click(screen.getByText('Save Configuration'));

    expect(mockSetConfigs).toHaveBeenCalledTimes(1);
    const saved = mockSetConfigs.mock.calls[0][0];
    expect(saved[0].name).toBe('Production Step-CA');
    expect(saved[0].caUrl).toBe('https://ca.prod.corp:30900');
    expect(mockSetDefaultId).toHaveBeenCalledWith(saved[0].id);
  });

  it('renders configured CA and triggers authentication test', async () => {
    const existing: SshCaConfig = {
      id: 'ca-1',
      name: 'Corporate Step-CA',
      backend: 'step-ca',
      caUrl: 'https://ca.corp:30900',
      oidcIssuerUrl: 'https://idp.corp/realms/ssh',
      oidcClientId: 'step-ca',
      keySource: 'ephemeral',
      defaultPrincipals: ['admin'],
    };
    configs = [existing];
    defaultId = 'ca-1';

    mockLogin.mockResolvedValueOnce({
      active: true,
      username: 'alun',
    });

    render(<SshCaSettingsPanel form={createMockForm()} />);

    expect(screen.getByText('Corporate Step-CA')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();

    const authBtn = screen.getByText('Authenticate with CA');
    fireEvent.click(authBtn);

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith(existing);
      expect(screen.getByText(/Successfully authenticated as alun/i)).toBeInTheDocument();
    });
  });

  it('deletes an existing CA configuration', () => {
    const existing: SshCaConfig = {
      id: 'ca-1',
      name: 'To Delete',
      backend: 'step-ca',
      caUrl: 'https://ca.example.com',
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'step-ca',
      keySource: 'ephemeral',
    };
    configs = [existing];

    render(<SshCaSettingsPanel form={createMockForm()} />);

    const deleteBtn = screen.getByLabelText('Delete');
    fireEvent.click(deleteBtn);

    expect(mockSetConfigs).toHaveBeenCalledWith([]);
  });

  describe('Detect', () => {
    const provisioner = { name: 'Keycloak', clientId: 'step-ca-client', issuerUrl: 'https://idp.example.com/realms/x' };
    const root = { pem: 'PEM-DATA', subject: 'O=Test, CN=Test Root', validTo: '2036-10-28T13:36:00.000Z', fingerprint: 'ab'.repeat(32) };

    const openNewForm = () => {
      render(<SshCaSettingsPanel form={createMockForm()} />);
      fireEvent.click(screen.getByTestId('add-ssh-ca-btn'));
      fireEvent.change(screen.getByPlaceholderText('https://ca.example.com:30900'), {
        target: { value: 'https://ca.example.com:9000' },
      });
    };

    const untrusted = new Error("Error invoking remote method 'ssh-ca:detect': Error: The CA's certificate is not trusted by this computer. Enter the root CA fingerprint.");

    it('asks for the fingerprint only after the CA turned out not to be trusted', async () => {
      const detect = vi.fn().mockRejectedValueOnce(untrusted).mockResolvedValue({ provisioners: [provisioner], root });
      (window.sshs3 as any).sshCaDetect = detect;
      openNewForm();
      expect(screen.queryByPlaceholderText(/step certificate fingerprint/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));
      await waitFor(() => expect(screen.getByPlaceholderText(/step certificate fingerprint/)).toBeInTheDocument());
      expect(detect).toHaveBeenLastCalledWith({ caUrl: 'https://ca.example.com:9000', rootFingerprint: undefined });
      expect(screen.getByRole('alert')).toHaveTextContent('is not trusted by this computer');

      fireEvent.change(screen.getByPlaceholderText(/step certificate fingerprint/), { target: { value: ' abc ' } });
      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));

      await waitFor(() => expect(screen.getByText(/Root certificate verified/)).toBeInTheDocument());
      expect(detect).toHaveBeenLastCalledWith({ caUrl: 'https://ca.example.com:9000', rootFingerprint: 'abc' });
      expect(screen.getByText(/valid until 2036-10-28/)).toBeInTheDocument();
      expect(screen.getByDisplayValue('https://idp.example.com/realms/x')).toBeInTheDocument();
      expect(screen.getByDisplayValue('step-ca-client')).toBeInTheDocument();
      expect(screen.getByDisplayValue('PEM-DATA')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Save Configuration'));
      expect(mockSetConfigs).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'Keycloak',
          caUrl: 'https://ca.example.com:9000',
          oidcIssuerUrl: 'https://idp.example.com/realms/x',
          oidcClientId: 'step-ca-client',
          rootCaCert: 'PEM-DATA',
        }),
      ]);
    });

    it('hides the fingerprint field again when the CA URL changes, and Enter in the URL field detects', async () => {
      const detect = vi.fn().mockRejectedValueOnce(untrusted).mockResolvedValue({ provisioners: [provisioner] });
      (window.sshs3 as any).sshCaDetect = detect;
      openNewForm();
      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));
      await waitFor(() => expect(screen.getByPlaceholderText(/step certificate fingerprint/)).toBeInTheDocument());

      const urlField = screen.getByPlaceholderText('https://ca.example.com:30900');
      fireEvent.change(urlField, { target: { value: 'https://other.example.com' } });
      expect(screen.queryByPlaceholderText(/step certificate fingerprint/)).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      fireEvent.keyDown(urlField, { key: 'Enter' });
      await waitFor(() => expect(detect).toHaveBeenCalledTimes(2));
      expect(detect).toHaveBeenLastCalledWith({ caUrl: 'https://other.example.com', rootFingerprint: undefined });
    });

    it('sends no fingerprint when the field is empty and keeps a name the user typed', async () => {
      const detect = vi.fn().mockResolvedValue({ provisioners: [provisioner] });
      (window.sshs3 as any).sshCaDetect = detect;
      openNewForm();
      fireEvent.change(screen.getByPlaceholderText('Step-CA Internal'), { target: { value: 'My CA' } });

      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));

      await waitFor(() => expect(screen.getByText(/Using provisioner "Keycloak"/)).toBeInTheDocument());
      expect(detect).toHaveBeenCalledWith({ caUrl: 'https://ca.example.com:9000', rootFingerprint: undefined });
      expect(screen.getByDisplayValue('My CA')).toBeInTheDocument();
      expect(screen.queryByText(/Root certificate verified/)).not.toBeInTheDocument();
    });

    it('lets the user choose between several provisioners', async () => {
      const second = { name: 'Other', clientId: 'other-client', issuerUrl: 'https://other.example.com' };
      (window.sshs3 as any).sshCaDetect = vi.fn().mockResolvedValue({ provisioners: [provisioner, second] });
      openNewForm();

      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));
      await waitFor(() => expect(screen.getByText('Other')).toBeInTheDocument());
      expect(screen.queryByDisplayValue('other-client')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Other'));
      expect(screen.getByDisplayValue('other-client')).toBeInTheDocument();
      expect(screen.getByDisplayValue('https://other.example.com')).toBeInTheDocument();
    });

    it('shows the error and leaves the form untouched', async () => {
      (window.sshs3 as any).sshCaDetect = vi
        .fn()
        .mockRejectedValue(new Error("Error invoking remote method 'ssh-ca:detect': Error: The CA's certificate is not trusted by this computer."));
      openNewForm();

      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("The CA's certificate is not trusted by this computer."));
      expect(screen.getByRole('alert')).not.toHaveTextContent('Error invoking remote method');
      expect(screen.queryByDisplayValue('step-ca-client')).not.toBeInTheDocument();
    });

    it('is not offered for Vault and is disabled without a CA URL', () => {
      render(<SshCaSettingsPanel form={createMockForm()} />);
      fireEvent.click(screen.getByTestId('add-ssh-ca-btn'));
      fireEvent.change(screen.getByPlaceholderText('https://ca.example.com:30900'), { target: { value: '' } });
      expect(screen.getByTestId('detect-ssh-ca-btn')).toBeDisabled();

      fireEvent.change(screen.getByDisplayValue('Smallstep (step-ca)'), { target: { value: 'vault' } });
      expect(screen.queryByTestId('detect-ssh-ca-btn')).not.toBeInTheDocument();
    });
  });

  describe('Detect (Vault)', () => {
    const key = (mount: string) => ({ mount, keyType: 'ssh-ed25519', fingerprint: `SHA256:fp-${mount}` });

    const openVaultForm = () => {
      render(<SshCaSettingsPanel form={createMockForm()} />);
      fireEvent.click(screen.getByTestId('add-ssh-ca-btn'));
      fireEvent.change(screen.getByDisplayValue('Smallstep (step-ca)'), { target: { value: 'vault' } });
      fireEvent.change(screen.getByPlaceholderText('https://ca.example.com:30900'), {
        target: { value: 'https://vault.example.com:8200' },
      });
    };

    it('fills in the single SSH mount and auth mount and shows the CA key fingerprint', async () => {
      const detect = vi.fn().mockResolvedValue({
        sshMounts: [key('ssh-client-signer')],
        authMounts: [{ mount: 'oidc', type: 'oidc' }],
      });
      (window.sshs3 as any).sshCaDetectVault = detect;
      openVaultForm();

      fireEvent.click(screen.getByTestId('detect-vault-btn'));

      await waitFor(() => expect(screen.getByText(/SSH secrets engine "ssh-client-signer" found/)).toBeInTheDocument());
      expect(detect).toHaveBeenCalledWith({ caUrl: 'https://vault.example.com:8200', namespace: undefined, rootCaCert: undefined });
      expect(screen.getByText('SHA256:fp-ssh-client-signer')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ssh-client-signer')).toBeInTheDocument();
      expect(screen.getByDisplayValue('oidc')).toBeInTheDocument();
      expect(screen.getByText(/Auth mount "oidc" filled in/)).toBeInTheDocument();
    });

    it('passes the namespace and root certificate that are already in the form', async () => {
      const detect = vi.fn().mockResolvedValue({ sshMounts: [key('ssh')], authMounts: [] });
      (window.sshs3 as any).sshCaDetectVault = detect;
      openVaultForm();
      fireEvent.change(screen.getByPlaceholderText(/-----BEGIN CERTIFICATE-----/), { target: { value: ' PEM ' } });

      fireEvent.click(screen.getByTestId('detect-vault-btn'));

      await waitFor(() => expect(detect).toHaveBeenCalled());
      expect(detect.mock.calls[0][0]).toMatchObject({ rootCaCert: 'PEM' });
    });

    it('lets the user choose between several SSH mounts and says when there are none', async () => {
      (window.sshs3 as any).sshCaDetectVault = vi.fn().mockResolvedValue({ sshMounts: [key('a'), key('b')], authMounts: [] });
      openVaultForm();
      fireEvent.click(screen.getByTestId('detect-vault-btn'));
      await waitFor(() => expect(screen.getByText('b')).toBeInTheDocument());
      expect(screen.queryByText(/SSH secrets engine "[ab]" found/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('b'));
      expect(screen.getByText(/SSH secrets engine "b" found/)).toBeInTheDocument();
      expect(screen.getByDisplayValue('b')).toBeInTheDocument();

      (window.sshs3 as any).sshCaDetectVault = vi.fn().mockResolvedValue({ version: '2.1.0', sshMounts: [], authMounts: [] });
      fireEvent.click(screen.getByTestId('detect-vault-btn'));
      await waitFor(() => expect(screen.getByText(/No SSH secrets engine found at ssh or ssh-client-signer \(server 2\.1\.0\)/)).toBeInTheDocument());
    });

    it('shows the error', async () => {
      (window.sshs3 as any).sshCaDetectVault = vi
        .fn()
        .mockRejectedValue(new Error("Error invoking remote method 'ssh-ca:detect-vault': Error: The server is sealed."));
      openVaultForm();
      fireEvent.click(screen.getByTestId('detect-vault-btn'));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The server is sealed.'));
      expect(screen.getByRole('alert')).not.toHaveTextContent('Error invoking');
    });

    it('is not shown for Step-CA', () => {
      render(<SshCaSettingsPanel form={createMockForm()} />);
      fireEvent.click(screen.getByTestId('add-ssh-ca-btn'));
      expect(screen.queryByTestId('detect-vault-btn')).not.toBeInTheDocument();
    });
  });

  describe('Detect: stale answers and form behaviour', () => {
    const p1 = { name: 'One', clientId: 'client-one', issuerUrl: 'https://one.example.com' };
    const p2 = { name: 'Two', clientId: 'client-two', issuerUrl: 'https://two.example.com' };
    const root = { pem: 'ROOT-OF-A', subject: 'CN=A', validTo: '2036-10-28T13:36:00.000Z', fingerprint: 'cd'.repeat(32) };

    const openStepForm = (url = 'https://a.example.com') => {
      render(<SshCaSettingsPanel form={createMockForm()} />);
      fireEvent.click(screen.getByTestId('add-ssh-ca-btn'));
      fireEvent.change(screen.getByLabelText('CA URL'), { target: { value: url } });
    };

    it('labels the CA URL field without the Detect button in its name', () => {
      openStepForm();
      expect(screen.getByLabelText('CA URL')).toBe(screen.getByPlaceholderText('https://ca.example.com:30900'));
      expect(screen.queryByLabelText('CA URL Detect')).not.toBeInTheDocument();
    });

    it('drops the previous CA\'s answer when the URL changes, so it cannot be applied to another CA', async () => {
      (window.sshs3 as any).sshCaDetect = vi.fn().mockResolvedValue({ provisioners: [p1, p2], root });
      openStepForm();
      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));
      await waitFor(() => expect(screen.getByText('Two')).toBeInTheDocument());
      expect(screen.getByText(/Root certificate verified/)).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('CA URL'), { target: { value: 'https://b.example.com' } });

      expect(screen.queryByText('Two')).not.toBeInTheDocument();
      expect(screen.queryByText(/Root certificate verified/)).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('ROOT-OF-A')).not.toBeInTheDocument();
    });

    it('ignores an answer that arrives after the URL was changed', async () => {
      let resolveDetect!: (v: unknown) => void;
      (window.sshs3 as any).sshCaDetect = vi.fn().mockReturnValue(new Promise((r) => { resolveDetect = r; }));
      openStepForm();
      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));
      fireEvent.change(screen.getByLabelText('CA URL'), { target: { value: 'https://b.example.com' } });

      resolveDetect({ provisioners: [p1], root });
      await new Promise((r) => setTimeout(r, 0));

      expect(screen.queryByDisplayValue('client-one')).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('ROOT-OF-A')).not.toBeInTheDocument();
      expect(screen.queryByText(/Using provisioner/)).not.toBeInTheDocument();
      expect(screen.getByTestId('detect-ssh-ca-btn')).not.toBeDisabled();
    });

    it('drops the previous Vault answer when the URL changes', async () => {
      (window.sshs3 as any).sshCaDetectVault = vi.fn().mockResolvedValue({
        sshMounts: [{ mount: 'a', keyType: 'ssh-ed25519', fingerprint: 'SHA256:a' }, { mount: 'b', keyType: 'ssh-ed25519', fingerprint: 'SHA256:b' }],
        authMounts: [],
      });
      render(<SshCaSettingsPanel form={createMockForm()} />);
      fireEvent.click(screen.getByTestId('add-ssh-ca-btn'));
      fireEvent.change(screen.getByDisplayValue('Smallstep (step-ca)'), { target: { value: 'vault' } });
      fireEvent.change(screen.getByLabelText('CA URL'), { target: { value: 'https://v1.example.com' } });
      fireEvent.click(screen.getByTestId('detect-vault-btn'));
      await waitFor(() => expect(screen.getByText('SHA256:b')).toBeInTheDocument());

      fireEvent.change(screen.getByLabelText('CA URL'), { target: { value: 'https://v2.example.com' } });

      expect(screen.queryByText('SHA256:b')).not.toBeInTheDocument();
    });

    it('verifies Step-CA against the custom root that is already in the form', async () => {
      const detect = vi.fn().mockResolvedValue({ provisioners: [p1] });
      (window.sshs3 as any).sshCaDetect = detect;
      openStepForm();
      fireEvent.change(screen.getByPlaceholderText(/-----BEGIN CERTIFICATE-----/), { target: { value: ' MY-ROOT ' } });

      fireEvent.click(screen.getByTestId('detect-ssh-ca-btn'));

      await waitFor(() => expect(detect).toHaveBeenCalled());
      expect(detect.mock.calls[0][0]).toMatchObject({ caUrl: 'https://a.example.com', rootCaCert: 'MY-ROOT' });
    });
  });

  describe('focus when the editor closes', () => {
    const existing: SshCaConfig = {
      id: 'ca-1',
      name: 'First',
      backend: 'step-ca',
      caUrl: 'https://ca.example.com',
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'step-ca',
      keySource: 'ephemeral',
    };

    it('returns to the Edit button of the CA after Cancel', async () => {
      configs = [existing];
      render(<SshCaSettingsPanel form={createMockForm()} />);
      const edit = screen.getByLabelText('Edit');
      edit.focus();
      fireEvent.click(edit);
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('Cancel'));

      await waitFor(() => expect(screen.getByLabelText('Edit')).toHaveFocus());
    });

    it('returns to the Add CA button after cancelling a new CA', async () => {
      render(<SshCaSettingsPanel form={createMockForm()} />);
      fireEvent.click(screen.getByTestId('add-ssh-ca-btn'));
      fireEvent.click(screen.getByText('Cancel'));
      await waitFor(() => expect(screen.getByTestId('add-ssh-ca-btn')).toHaveFocus());
    });

    it('moves to the Edit button of the saved CA after Save', async () => {
      configs = [existing];
      const { rerender } = render(<SshCaSettingsPanel form={createMockForm()} />);
      fireEvent.click(screen.getByLabelText('Edit'));
      fireEvent.click(screen.getByText('Save Configuration'));
      rerender(<SshCaSettingsPanel form={createMockForm()} />);
      await waitFor(() => expect(screen.getByLabelText('Edit')).toHaveFocus());
    });
  });
});
