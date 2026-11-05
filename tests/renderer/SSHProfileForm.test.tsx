// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SSHProfileForm } from '../../src/renderer/src/components/ConnectionModal/SSHProfileForm';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

describe('SSHProfileForm', () => {
  beforeEach(() => {
    window.multissh = {
      dotfilePoolsGet: vi.fn().mockResolvedValue([]),
      profilesGet: vi.fn().mockResolvedValue({ ssh: [], s3: [] }),
      smartcardDetect: vi.fn().mockResolvedValue([]),
      testSSHConnection: vi.fn().mockResolvedValue({ success: true }),
      selectFile: vi.fn().mockResolvedValue(null),
    } as unknown as typeof window.multissh;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders and allows toggling Forward SSH Agent checkbox under Advanced Options', async () => {
    const onSave = vi.fn();
    const initialConfig: SSHConnectionConfig = {
      id: 'test-1',
      name: 'Bastion Host',
      host: 'bastion.example.com',
      port: 22,
      username: 'admin',
      authType: 'password',
      password: 'secretpassword',
    };

    render(
      <SSHProfileForm
        initial={initialConfig}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );

    // Expand Advanced Options
    const advancedBtn = screen.getByRole('button', { name: /Advanced SSH Options/i });
    fireEvent.click(advancedBtn);

    // Checkbox for Forward SSH Agent
    const forwardAgentCheckbox = screen.getByLabelText(/Forward SSH Agent/i) as HTMLInputElement;
    expect(forwardAgentCheckbox).toBeInTheDocument();
    expect(forwardAgentCheckbox.checked).toBe(false);

    // Toggle Forward SSH Agent
    fireEvent.click(forwardAgentCheckbox);
    expect(forwardAgentCheckbox.checked).toBe(true);

    // Submit form
    const saveBtn = screen.getByRole('button', { name: /Save Profile/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-1',
          name: 'Bastion Host',
          host: 'bastion.example.com',
          username: 'admin',
          forwardAgent: true,
        })
      );
    });
  });

  it('initializes Forward SSH Agent checkbox as checked if forwardAgent is true in initial config', () => {
    const initialConfig: SSHConnectionConfig = {
      id: 'test-2',
      name: 'Jump Host',
      host: 'jump.example.com',
      port: 22,
      username: 'dev',
      authType: 'password',
      forwardAgent: true,
    };

    render(
      <SSHProfileForm
        initial={initialConfig}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    // Expand Advanced Options
    const advancedBtn = screen.getByRole('button', { name: /Advanced SSH Options/i });
    fireEvent.click(advancedBtn);

    const forwardAgentCheckbox = screen.getByLabelText(/Forward SSH Agent/i) as HTMLInputElement;
    expect(forwardAgentCheckbox.checked).toBe(true);
  });

  it('renders and allows toggling Forward X11 GUI checkbox and setting display location', async () => {
    (window.multissh as any).checkX11Server = vi.fn().mockResolvedValue({ running: true, display: '127.0.0.1:0.0' });
    const onSave = vi.fn();
    const initialConfig: SSHConnectionConfig = {
      id: 'test-x11',
      name: 'GUI Host',
      host: 'gui.example.com',
      port: 22,
      username: 'admin',
      authType: 'password',
    };

    render(
      <SSHProfileForm
        initial={initialConfig}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );

    // Expand Advanced Options
    const advancedBtn = screen.getByRole('button', { name: /Advanced SSH Options/i });
    fireEvent.click(advancedBtn);

    // Checkbox for Forward X11 GUI
    const x11Checkbox = screen.getByLabelText(/Forward X11 GUI/i) as HTMLInputElement;
    expect(x11Checkbox).toBeInTheDocument();
    expect(x11Checkbox.checked).toBe(false);

    // Toggle Forward X11 GUI
    fireEvent.click(x11Checkbox);
    expect(x11Checkbox.checked).toBe(true);

    // Display location input appears
    const displayInput = screen.getByPlaceholderText('127.0.0.1:0.0') as HTMLInputElement;
    expect(displayInput).toBeInTheDocument();
    fireEvent.change(displayInput, { target: { value: 'localhost:0.0' } });

    // Submit form
    const saveBtn = screen.getByRole('button', { name: /Save Profile/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-x11',
          name: 'GUI Host',
          x11Forwarding: true,
          x11Display: 'localhost:0.0',
        })
      );
    });
  });

  it('offers an overwrite retry when generating a FIDO2 key hits a stale local file, even through Electron\'s wrapped error message', async () => {
    const fido2GenerateKey = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Error invoking remote method 'fido2:generate-key': Error: FIDO2_KEY_FILE_EXISTS: A file already exists at /home/alun/.ssh/id_ed25519_sk."
        )
      )
      .mockResolvedValueOnce({
        publicKey: 'sk-ssh-ed25519@openssh.com AAAA...',
        privateKeyPath: '/home/alun/.ssh/id_ed25519_sk',
        publicKeyPath: '/home/alun/.ssh/id_ed25519_sk.pub',
      });
    window.multissh = {
      ...window.multissh,
      fido2GenerateKey,
      fido2ListResidentKeys: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.multissh;

    const initialConfig: SSHConnectionConfig = {
      id: 'test-fido2',
      name: 'Fido2 Host',
      host: 'fido2.example.com',
      port: 22,
      username: 'admin',
      authType: 'fido2',
      fido2Resident: true,
    };

    render(<SSHProfileForm initial={initialConfig} onSave={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Generate a new key on this security key/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Generate Key$/i }));

    await waitFor(() => {
      expect(screen.getByText(/A file already exists at \/home\/alun\/\.ssh\/id_ed25519_sk\./)).toBeInTheDocument();
    });
    const overwriteBtn = screen.getByRole('button', { name: /Overwrite/i });
    expect(overwriteBtn).toBeInTheDocument();

    fireEvent.click(overwriteBtn);

    await waitFor(() => {
      expect(fido2GenerateKey).toHaveBeenLastCalledWith(expect.objectContaining({ overwrite: true }));
    });
  });

  describe('smartcard library default', () => {
    const libs = [
      { name: 'YubiKey (libykcs11)', path: '/usr/lib64/libykcs11.so.2', exists: true },
      { name: 'p11-kit', path: '/usr/lib64/p11-kit-proxy.so', exists: true },
      { name: 'OpenSC', path: '/usr/lib64/pkcs11/opensc-pkcs11.so', exists: true },
      { name: 'Net iD', path: '/usr/lib64/libiidp11.so', exists: false },
    ];

    it('starts on p11-kit when a smartcard profile has no library yet, and never on a module that is not installed', async () => {
      window.multissh.smartcardDetect = vi.fn().mockResolvedValue(libs) as any;
      render(<SSHProfileForm onSave={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.change(screen.getByLabelText(/Authentication/i), { target: { value: 'smartcard' } });

      const input = await screen.findByPlaceholderText('/usr/lib64/p11-kit-proxy.so');
      await waitFor(() => expect(input).toHaveValue('/usr/lib64/p11-kit-proxy.so'));
      expect(screen.queryByPlaceholderText(/libiidp11/)).not.toBeInTheDocument();
    });

    it('falls back to the first detected module when p11-kit is not installed', async () => {
      window.multissh.smartcardDetect = vi.fn().mockResolvedValue(libs.filter((l) => l.name !== 'p11-kit')) as any;
      render(<SSHProfileForm onSave={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.change(screen.getByLabelText(/Authentication/i), { target: { value: 'smartcard' } });
      await waitFor(() => expect(screen.getByPlaceholderText('/usr/lib64/libykcs11.so.2')).toHaveValue('/usr/lib64/libykcs11.so.2'));
    });

    it('does not override a library the profile already has', async () => {
      window.multissh.smartcardDetect = vi.fn().mockResolvedValue(libs) as any;
      render(
        <SSHProfileForm
          initial={{ id: 'x', name: 'n', host: 'h', username: 'u', authType: 'smartcard', pkcs11LibPath: '/opt/custom.so' }}
          onSave={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      await waitFor(() => expect(window.multissh.smartcardDetect).toHaveBeenCalled());
      await screen.findByText('Detected modules on system:');
      expect(screen.getByDisplayValue('/opt/custom.so')).toBeInTheDocument();
    });

    it('Install key stays blocked until a library is chosen when nothing was detected', async () => {
      window.multissh.smartcardDetect = vi.fn().mockResolvedValue([]) as any;
      render(<SSHProfileForm onSave={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.change(screen.getByLabelText(/Profile Name/i), { target: { value: 'n' } });
      fireEvent.change(screen.getByLabelText(/^Host/i), { target: { value: 'h' } });
      fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: 'u' } });
      fireEvent.change(screen.getByLabelText(/Authentication/i), { target: { value: 'smartcard' } });

      expect(screen.getByRole('button', { name: /Install key/ })).toBeDisabled();
      expect(screen.getByText('Choose a PKCS#11 library first.')).toBeInTheDocument();

      fireEvent.change(screen.getByPlaceholderText('/usr/lib64/p11-kit-proxy.so'), { target: { value: '/opt/lib.so' } });
      expect(screen.getByRole('button', { name: /Install key/ })).toBeEnabled();
    });
  });

  describe('save reminder for unverified key profiles', () => {
    const fill = (authTypeLabel?: string) => {
      fireEvent.change(screen.getByLabelText(/Profile Name/i), { target: { value: 'New host' } });
      fireEvent.change(screen.getByLabelText(/^Host/i), { target: { value: 'db.internal' } });
      fireEvent.change(screen.getByLabelText(/Username/i), { target: { value: 'alice' } });
      if (authTypeLabel) fireEvent.change(screen.getByLabelText(/Authentication/i), { target: { value: authTypeLabel } });
    };

    it('asks before saving a NEW key-based profile that was never verified, and lets the user save anyway', async () => {
      const onSave = vi.fn();
      render(<SSHProfileForm onSave={onSave} onCancel={vi.fn()} />);
      fill('agent');

      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      expect(await screen.findByTestId('save-reminder-dialog')).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('save-reminder-dialog')).not.toBeInTheDocument();
    });

    it('"Set up access" closes the reminder and opens the install dialog without saving', async () => {
      window.multissh.listPublicKeys = vi.fn().mockResolvedValue([]) as any;
      const onSave = vi.fn();
      render(<SSHProfileForm onSave={onSave} onCancel={vi.fn()} />);
      fill('agent');

      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Set up access' }));

      expect(await screen.findByTestId('install-key-modal')).toBeInTheDocument();
      expect(screen.queryByTestId('save-reminder-dialog')).not.toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('saves directly once the login has been verified', async () => {
      window.multissh.sshProbeHost = vi.fn().mockResolvedValue({ reachable: true, hostKey: 'trusted', methods: ['publickey'] }) as any;
      window.multissh.sshTestLogin = vi.fn().mockResolvedValue({ success: true }) as any;
      const onSave = vi.fn();
      render(<SSHProfileForm onSave={onSave} onCancel={vi.fn()} />);
      fill('agent');

      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => expect(screen.getByTestId('access-step-verified')).toHaveAttribute('data-status', 'ok'));

      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      expect(screen.queryByTestId('save-reminder-dialog')).not.toBeInTheDocument();
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('does not nag after a key was successfully installed from the Access panel (the reported bug)', async () => {
      window.multissh.listPublicKeys = vi.fn().mockResolvedValue([
        { id: 'SHA256:k', line: 'ssh-ed25519 AAAA me', type: 'ssh-ed25519', fingerprint: 'SHA256:k', comment: 'me', source: 'file', label: 'id.pub' },
      ]) as any;
      window.multissh.installPublicKeys = vi.fn().mockResolvedValue({
        success: true,
        loginMethod: 'password',
        results: [{ fingerprint: 'SHA256:k', status: 'installed' }],
      }) as any;
      const onSave = vi.fn();
      render(<SSHProfileForm onSave={onSave} onCancel={vi.fn()} />);
      fill('agent');

      fireEvent.click(screen.getByRole('button', { name: /Install key/ }));
      fireEvent.click(await screen.findByLabelText('Select id.pub'));
      fireEvent.click(screen.getByRole('button', { name: /Install 1 key/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Done' }));
      // Timeline step and footer status.
      expect(await screen.findAllByText('Key installed')).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      expect(screen.queryByTestId('save-reminder-dialog')).not.toBeInTheDocument();
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('asks again if the host/credentials change after a successful install', async () => {
      window.multissh.listPublicKeys = vi.fn().mockResolvedValue([
        { id: 'SHA256:k', line: 'ssh-ed25519 AAAA me', type: 'ssh-ed25519', fingerprint: 'SHA256:k', comment: 'me', source: 'file', label: 'id.pub' },
      ]) as any;
      window.multissh.installPublicKeys = vi.fn().mockResolvedValue({
        success: true,
        results: [{ fingerprint: 'SHA256:k', status: 'installed' }],
      }) as any;
      const onSave = vi.fn();
      render(<SSHProfileForm onSave={onSave} onCancel={vi.fn()} />);
      fill('agent');
      fireEvent.click(screen.getByRole('button', { name: /Install key/ }));
      fireEvent.click(await screen.findByLabelText('Select id.pub'));
      fireEvent.click(screen.getByRole('button', { name: /Install 1 key/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Done' }));

      fireEvent.change(screen.getByLabelText(/^Host/i), { target: { value: 'another.host' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      expect(await screen.findByTestId('save-reminder-dialog')).toBeInTheDocument();
    });

    it('never nags for password profiles', () => {
      const onSave = vi.fn();
      render(<SSHProfileForm onSave={onSave} onCancel={vi.fn()} />);
      fill();
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      expect(screen.queryByTestId('save-reminder-dialog')).not.toBeInTheDocument();
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('never nags when editing an existing profile', () => {
      const onSave = vi.fn();
      render(
        <SSHProfileForm
          initial={{ id: 'x', name: 'Old', host: 'h', username: 'u', authType: 'agent' }}
          onSave={onSave}
          onCancel={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      expect(screen.queryByTestId('save-reminder-dialog')).not.toBeInTheDocument();
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('system', () => {
    const base: SSHConnectionConfig = {
      id: 'test-1',
      name: 'Web',
      host: 'web.example.com',
      port: 22,
      username: 'deploy',
      authType: 'privateKey',
      tunnels: [{ id: 't1', name: 'Database', type: 'local', localPort: 5432, remoteHost: 'localhost', remotePort: 5432 }],
    };

    it('puts the server into a system, with its terminal start directory and tunnels, when it is saved', async () => {
      const onSave = vi.fn();
      render(<SSHProfileForm initial={base} onSave={onSave} onCancel={vi.fn()} systemSuggestions={['shop']} />);

      fireEvent.change(screen.getByLabelText('System (optional)'), { target: { value: 'shop' } });
      fireEvent.change(screen.getByLabelText('Start directory'), { target: { value: '/srv/web' } });
      fireEvent.click(screen.getByLabelText('Database'));
      fireEvent.click(screen.getByRole('button', { name: /Save Profile/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave.mock.calls[0][0].system).toEqual({ name: 'shop', startDirectory: '/srv/web', tunnelIds: ['t1'] });
    });

    it('shows the folder of a server in a system but does not let it be edited there', () => {
      render(<SSHProfileForm initial={{ ...base, group: 'Prod', system: { name: 'shop' } }} onSave={vi.fn()} onCancel={vi.fn()} />);
      const folder = screen.getByLabelText(/Group \/ Folder/);
      expect(folder).toHaveValue('Prod');
      expect(folder).toHaveAttribute('readonly');
      expect(screen.getByText('Follows the system')).toBeInTheDocument();
    });

    it('frees the folder as soon as the System field is cleared', () => {
      render(<SSHProfileForm initial={{ ...base, group: 'Prod', system: { name: 'shop' } }} onSave={vi.fn()} onCancel={vi.fn()} />);
      fireEvent.change(screen.getByLabelText('System (optional)'), { target: { value: '' } });
      expect(screen.getByLabelText(/Group \/ Folder/)).not.toHaveAttribute('readonly');
    });

    it('lets the folder be edited for a server that is in no system', () => {
      render(<SSHProfileForm initial={{ ...base, group: 'Prod' }} onSave={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.getByLabelText(/Group \/ Folder/)).not.toHaveAttribute('readonly');
      expect(screen.queryByText('Follows the system')).not.toBeInTheDocument();
    });

    it('shows the system a server is already in, and takes it out when the name is cleared', async () => {
      const onSave = vi.fn();
      render(<SSHProfileForm initial={{ ...base, system: { name: 'shop', shell: false } }} onSave={onSave} onCancel={vi.fn()} />);
      expect(screen.getByLabelText('System (optional)')).toHaveValue('shop');
      expect(screen.getByLabelText('Open a terminal to this server')).not.toBeChecked();

      fireEvent.change(screen.getByLabelText('System (optional)'), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: /Save Profile/i }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave.mock.calls[0][0].system).toBeUndefined();
    });

    it('does not add a system to a profile that has none', async () => {
      const onSave = vi.fn();
      render(<SSHProfileForm initial={base} onSave={onSave} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Save Profile/i }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect('system' in onSave.mock.calls[0][0] && onSave.mock.calls[0][0].system !== undefined).toBe(false);
    });
  });
});
