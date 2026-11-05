// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import { K8sConnectionTree } from '../../src/renderer/src/components/ConnectionModal/K8sConnectionTree';

function renderTree(ui: React.ReactElement) {
  return render(<ConfirmProvider>{ui}</ConfirmProvider>);
}

describe('K8sConnectionTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as any).multissh = {
      k8sListContexts: vi.fn().mockResolvedValue([
        {
          contextName: 'minikube',
          clusterName: 'minikube',
          server: 'https://192.168.49.2:8443',
          user: 'minikube',
          isCurrent: true,
          namespaces: [],
        },
      ]),
      k8sListNamespaces: vi.fn().mockResolvedValue([
        { name: 'default', pods: [] },
      ]),
      k8sListPods: vi.fn().mockResolvedValue([
        {
          name: 'nginx-pod',
          namespace: 'default',
          phase: 'Running',
          containers: [
            {
              name: 'nginx',
              image: 'nginx:alpine',
              ready: true,
              state: 'running',
              ports: [{ containerPort: 80 }],
            },
          ],
        },
      ]),
      k8sDeletePod: vi.fn().mockResolvedValue(undefined),
      k8sListPortForwards: vi.fn().mockResolvedValue([]),
      onK8sPortForwardEvent: vi.fn().mockReturnValue(() => {}),
      k8sReload: vi.fn().mockResolvedValue(undefined),
      k8sLogin: vi.fn().mockResolvedValue({
        success: true,
        contextName: 'default/api-test-com:6443/user',
        clusterName: 'api-test-com:6443',
        userName: 'user/api-test-com:6443',
        server: 'https://api.test.com:6443',
        namespace: 'default',
        projects: ['default'],
      }),
      onK8sConfigChanged: vi.fn().mockReturnValue(() => {}),
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders context, expands namespace, and triggers onBrowseFiles when Files button is clicked', async () => {
    const handleBrowseFiles = vi.fn();
    const handleExec = vi.fn();
    const handleViewLogs = vi.fn();

    renderTree(
      <K8sConnectionTree
        onBrowseFiles={handleBrowseFiles}
        onExec={handleExec}
        onViewLogs={handleViewLogs}
      />
    );

    // Context should load
    expect(await screen.findByText('minikube')).toBeInTheDocument();

    // Click context to expand namespaces
    await act(async () => {
      fireEvent.click(screen.getByText('minikube'));
    });
    expect(await screen.findByText('default')).toBeInTheDocument();

    // Click namespace to expand pods
    await act(async () => {
      fireEvent.click(screen.getByText('default'));
    });
    expect(await screen.findByText('nginx-pod')).toBeInTheDocument();

    // Click pod to expand containers
    await act(async () => {
      fireEvent.click(screen.getByText('nginx-pod'));
    });
    expect(await screen.findByText('nginx')).toBeInTheDocument();

    // Find and click "Files" button
    const filesBtn = screen.getByTitle('Browse container filesystem');
    expect(filesBtn).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(filesBtn);
    });

    expect(handleBrowseFiles).toHaveBeenCalledWith({
      contextName: 'minikube',
      namespace: 'default',
      podName: 'nginx-pod',
      containerName: 'nginx',
    });
  });

  it('requests namespaces and pods once per expansion, also when React runs state updaters twice (StrictMode)', async () => {
    render(
      <React.StrictMode>
        <ConfirmProvider>
          <K8sConnectionTree />
        </ConfirmProvider>
      </React.StrictMode>
    );
    expect(await screen.findByText('minikube')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText('minikube'));
    });
    expect(await screen.findByText('default')).toBeInTheDocument();
    expect((window as any).multissh.k8sListNamespaces).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByText('default'));
    });
    expect(await screen.findByText('nginx-pod')).toBeInTheDocument();
    expect((window as any).multissh.k8sListPods).toHaveBeenCalledTimes(1);
  });

  it('collapses and expands again without asking for the namespaces a second time', async () => {
    renderTree(<K8sConnectionTree />);
    expect(await screen.findByText('minikube')).toBeInTheDocument();

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        fireEvent.click(screen.getByText('minikube'));
      });
    }
    expect((window as any).multissh.k8sListNamespaces).toHaveBeenCalledTimes(1);
  });

  it('does not show OpenShift login button when enableOpenShift is false or omitted', async () => {
    renderTree(<K8sConnectionTree enableOpenShift={false} />);

    expect(await screen.findByText('minikube')).toBeInTheDocument();
    expect(screen.queryByTitle('Log in to OpenShift or Kubernetes with token')).not.toBeInTheDocument();
    expect(screen.queryByText('OpenShift Login')).not.toBeInTheDocument();
  });

  it('does not show OpenShift login button in empty state when enableOpenShift is false', async () => {
    (window as any).multissh.k8sListContexts.mockResolvedValueOnce([]);

    renderTree(<K8sConnectionTree enableOpenShift={false} />);

    expect(await screen.findByText('No contexts found in ~/.kube/config')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /OpenShift \/ Kubernetes Login/ })).not.toBeInTheDocument();
  });

  it('opens OpenShift Login modal and performs token login when enableOpenShift is true', async () => {
    renderTree(<K8sConnectionTree enableOpenShift={true} />);

    expect(await screen.findByText('minikube')).toBeInTheDocument();

    const loginBtn = screen.getByTitle('Log in to OpenShift or Kubernetes with token');
    expect(loginBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(loginBtn);
    });

    expect(screen.getByRole('dialog', { name: 'OpenShift / Kubernetes login' })).toBeInTheDocument();

    // Paste an oc login command
    const pasteArea = screen.getByPlaceholderText(/oc login --token=/);
    await act(async () => {
      fireEvent.change(pasteArea, {
        target: { value: 'oc login --token=sha256~secret123 --server=https://api.mycluster.com:6443 --insecure-skip-tls-verify' },
      });
    });

    // Check that server and token fields auto-populated
    expect(screen.getByPlaceholderText('https://api.mycluster.example.com:6443')).toHaveValue('https://api.mycluster.com:6443');
    expect(screen.getByPlaceholderText('sha256~...')).toHaveValue('sha256~secret123');

    // Click submit
    const submitBtn = screen.getByRole('button', { name: /Log in & Connect/ });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect((window as any).multissh.k8sLogin).toHaveBeenCalledWith({
      server: 'https://api.mycluster.com:6443',
      token: 'sha256~secret123',
      namespace: undefined,
      insecureSkipTlsVerify: true,
    });
  });

  it('shows OpenShift / Kubernetes Login button when no contexts exist and enableOpenShift is true', async () => {
    (window as any).multissh.k8sListContexts.mockResolvedValueOnce([]);

    renderTree(<K8sConnectionTree enableOpenShift={true} />);

    expect(await screen.findByText('No contexts found in ~/.kube/config')).toBeInTheDocument();
    const loginBtn = screen.getByRole('button', { name: /OpenShift \/ Kubernetes Login/ });
    expect(loginBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(loginBtn);
    });

    expect(screen.getByRole('dialog', { name: 'OpenShift / Kubernetes login' })).toBeInTheDocument();
  });

  it('deletes pod when clicking delete button and confirming dialog', async () => {
    renderTree(<K8sConnectionTree />);

    expect(await screen.findByText('minikube')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('minikube'));
    });

    expect(await screen.findByText('default')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByText('default'));
    });

    expect(await screen.findByText('nginx-pod')).toBeInTheDocument();

    const deleteBtn = screen.getByTitle('Delete or restart pod');
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/Delete pod \S+\?/);

    const confirmBtn = within(dialog).getByRole('button', { name: 'Delete' });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect((window as any).multissh.k8sDeletePod).toHaveBeenCalledWith('minikube', 'default', 'nginx-pod');
  });

  describe('saved cluster profiles', () => {
    const profile = {
      id: 'p1',
      name: 'Production',
      server: 'https://192.168.49.2:8443',
      namespace: 'team-a',
      contextName: 'minikube',
    };

    it('shows only the profile project and never lists the whole cluster', async () => {
      (window as any).multissh.k8sProfilesList = vi.fn().mockResolvedValue([profile]);
      renderTree(<K8sConnectionTree enableOpenShift={true} />);

      const name = await screen.findByText('Production');
      await act(async () => {
        fireEvent.click(name);
      });

      expect(await screen.findByText('team-a', { selector: 'span.truncate' })).toBeInTheDocument();
      expect(screen.queryByText('default')).not.toBeInTheDocument();
      expect((window as any).multissh.k8sListNamespaces).not.toHaveBeenCalled();
    });

    it('lists the whole cluster when the profile has no project', async () => {
      (window as any).multissh.k8sProfilesList = vi
        .fn()
        .mockResolvedValue([{ ...profile, namespace: undefined }]);
      renderTree(<K8sConnectionTree enableOpenShift={true} />);

      const name = await screen.findByText('Production');
      await act(async () => {
        fireEvent.click(name);
      });
      expect(await screen.findByText('default')).toBeInTheDocument();
      expect((window as any).multissh.k8sListNamespaces).toHaveBeenCalledWith('minikube');
    });

    it('lists a saved cluster that has no kubeconfig context and signs in to it', async () => {
      (window as any).multissh.k8sProfilesList = vi
        .fn()
        .mockResolvedValue([{ id: 'p2', name: 'Staging', server: 'https://staging.example.com:6443' }]);
      renderTree(<K8sConnectionTree enableOpenShift={true} />);

      expect(await screen.findByText('Staging')).toBeInTheDocument();
      expect(screen.getByText('not signed in')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
      });
      expect(screen.getByLabelText('API server URL')).toHaveValue('https://staging.example.com:6443');
      expect(screen.getByLabelText('Profile name')).toHaveValue('Staging');
    });

    it('removes a profile after confirming, keeping the kubeconfig untouched', async () => {
      const list = vi.fn().mockResolvedValueOnce([profile]).mockResolvedValue([]);
      (window as any).multissh.k8sProfilesList = list;
      (window as any).multissh.k8sProfilesDelete = vi.fn().mockResolvedValue(undefined);
      renderTree(<K8sConnectionTree enableOpenShift={true} />);

      await screen.findByText('Production');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Remove profile Production' }));
      });
      const confirmButton = await screen.findByRole('button', { name: 'Remove' });
      await act(async () => {
        fireEvent.click(confirmButton);
      });

      expect((window as any).multissh.k8sProfilesDelete).toHaveBeenCalledWith('p1');
      expect(await screen.findByText('minikube')).toBeInTheDocument();
    });
  });

  describe('Team Vault cluster templates', () => {
    const template = { id: 't1', name: 'Shared prod', server: 'https://shared.example.com:6443', namespace: 'team-a' };

    function mockTeam(over: Record<string, unknown> = {}) {
      Object.assign((window as any).multissh, {
        teamVaultList: vi.fn().mockResolvedValue([
          { exists: true, vaultId: 'v1', vaultName: 'Platform', unlocked: true, filePath: '' },
          { exists: true, vaultId: 'v2', vaultName: 'Locked team', unlocked: false, filePath: '' },
        ]),
        teamVaultGetPayload: vi.fn().mockResolvedValue({ ssh: [], s3: [], k8s: [template] }),
        settingsGet: vi.fn().mockResolvedValue({}),
        teamVaultSaveK8sProfile: vi.fn().mockResolvedValue(undefined),
        teamVaultDeleteK8sProfile: vi.fn().mockResolvedValue(undefined),
        k8sProfilesList: vi.fn().mockResolvedValue([]),
        ...over,
      });
    }

    it('lists templates of unlocked vaults only and counts the locked ones', async () => {
      mockTeam();
      renderTree(<K8sConnectionTree enableOpenShift={true} />);

      expect(await screen.findByText('Shared prod')).toBeInTheDocument();
      expect(screen.getByText('Platform')).toBeInTheDocument();
      expect((window as any).multissh.teamVaultGetPayload).toHaveBeenCalledTimes(1);
      expect((window as any).multissh.teamVaultGetPayload).toHaveBeenCalledWith('v1');
      expect(screen.getByText(/1 locked team vault not shown/)).toBeInTheDocument();
    });

    it('shows nothing team-related when OpenShift support is off', async () => {
      mockTeam();
      renderTree(<K8sConnectionTree enableOpenShift={false} />);
      expect(await screen.findByText('minikube')).toBeInTheDocument();
      expect(screen.queryByTestId('k8s-team-vault-section')).not.toBeInTheDocument();
    });

    it('signing in to a template opens the dialog with a personal copy that has its own id', async () => {
      mockTeam();
      renderTree(<K8sConnectionTree enableOpenShift={true} />);
      await screen.findByText('Shared prod');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
      });

      expect(screen.getByLabelText('API server URL')).toHaveValue('https://shared.example.com:6443');
      expect(screen.getByLabelText('Default project / namespace')).toHaveValue('team-a');
      expect(screen.getByLabelText('Profile name')).toHaveValue('Shared prod');
    });

    it('reuses the personal profile that already covers the template instead of duplicating it', async () => {
      const personal = { id: 'mine', name: 'My prod', server: 'https://SHARED.example.com:6443/', namespace: 'team-a' };
      mockTeam({ k8sProfilesList: vi.fn().mockResolvedValue([personal]) });
      renderTree(<K8sConnectionTree enableOpenShift={true} />);
      await screen.findByText('Shared prod');
      const teamSection = screen.getByTestId('k8s-team-vault-section');
      await act(async () => {
        fireEvent.click(within(teamSection).getByRole('button', { name: /^sign in$/i }));
      });
      expect(screen.getByLabelText('Profile name')).toHaveValue('My prod');
    });

    it('shares a personal profile to the only unlocked vault without its kubeconfig context', async () => {
      const personal = { id: 'p9', name: 'Mine', server: 'https://own.example.com:6443', namespace: 'dev', contextName: 'dev/own/alice', lastUsedAt: '2026-01-01T00:00:00.000Z' };
      mockTeam({ k8sProfilesList: vi.fn().mockResolvedValue([personal]) });
      renderTree(<K8sConnectionTree enableOpenShift={true} />);
      await screen.findByText('Shared prod');
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: 'Share profile Mine to a team' }));
      });
      expect((window as any).multissh.teamVaultSaveK8sProfile).toHaveBeenCalledWith('v1', {
        id: 'p9',
        name: 'Mine',
        server: 'https://own.example.com:6443',
        namespace: 'dev',
        insecureSkipTlsVerify: undefined,
      });
    });

    it('shows why sharing failed instead of dropping the error, and the message can be dismissed', async () => {
      const personal = { id: 'p9', name: 'Mine', server: 'https://own.example.com:6443', namespace: 'dev', contextName: 'dev/own/alice', lastUsedAt: '2026-01-01T00:00:00.000Z' };
      mockTeam({
        k8sProfilesList: vi.fn().mockResolvedValue([personal]),
        teamVaultSaveK8sProfile: vi.fn().mockRejectedValue(new Error('vault is read-only')),
      });
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        renderTree(<K8sConnectionTree enableOpenShift={true} />);
        await screen.findByText('Shared prod');
        await act(async () => {
          fireEvent.click(await screen.findByRole('button', { name: 'Share profile Mine to a team' }));
        });
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not share the cluster with the team');
        expect(screen.getByRole('alert')).toHaveTextContent('vault is read-only');
        await new Promise((r) => setTimeout(r, 20));
        expect(unhandled).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('removes a template for the team after confirming', async () => {
      mockTeam();
      renderTree(<K8sConnectionTree enableOpenShift={true} />);
      await screen.findByText('Shared prod');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Remove shared cluster Shared prod' }));
      });
      const confirmButton = await screen.findByRole('button', { name: 'Remove' });
      await act(async () => {
        fireEvent.click(confirmButton);
      });
      expect((window as any).multissh.teamVaultDeleteK8sProfile).toHaveBeenCalledWith('v1', 't1');
    });

    it('adds a template through the form, which has no token field', async () => {
      mockTeam();
      renderTree(<K8sConnectionTree enableOpenShift={true} />);
      await screen.findByText('Shared prod');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Add shared cluster to Platform' }));
      });
      expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Staging' } });
      fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://staging.example.com:6443' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      });
      expect((window as any).multissh.teamVaultSaveK8sProfile).toHaveBeenCalledWith(
        'v1',
        expect.objectContaining({ name: 'Staging', server: 'https://staging.example.com:6443', id: expect.any(String) })
      );
    });
  });
});
