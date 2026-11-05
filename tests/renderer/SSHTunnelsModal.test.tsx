// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SSHTunnelsModal } from '../../src/renderer/src/components/SSH/SSHTunnelsModal';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { SSHActiveTunnel, SSHConnectionConfig } from '../../src/shared/types/ssh';

const connection: SSHConnectionConfig = {
  id: 'conn-1',
  name: 'Bastion',
  host: 'bastion.example.com',
  username: 'alice',
  authType: 'password',
  tunnels: [],
};

const temporary: SSHActiveTunnel = {
  id: 'run-1',
  connectionId: 'conn-1',
  connectionName: 'Bastion',
  tunnel: { id: 'adhoc-1', name: 'adhoc', type: 'local', localPort: 8080, remoteHost: 'db.internal', remotePort: 5432 },
  status: 'active',
  startedAt: '2026-10-01T10:00:00Z',
};

describe('SSHTunnelsModal temporary tunnels', () => {
  afterEach(() => cleanup());

  it('asks before stopping a tunnel that is not saved, and only stops it once confirmed', async () => {
    const sshTunnelStop = vi.fn().mockResolvedValue(undefined);
    window.multissh = {
      sshTunnelList: vi.fn().mockResolvedValue([temporary]),
      onSshTunnelEvent: vi.fn(() => () => undefined),
      sshTunnelStop,
    } as unknown as typeof window.multissh;
    render(
      <ConfirmProvider>
        <SSHTunnelsModal connection={connection} open onClose={vi.fn()} />
      </ConfirmProvider>
    );
    await waitFor(() => expect(screen.getByText('Temporary Tunnels (not saved)')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('It is not saved, so you would have to set it up again.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(sshTunnelStop).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop tunnel' }));
    await waitFor(() => expect(sshTunnelStop).toHaveBeenCalledWith('run-1'));
  });

  it('shows the wizard progress as an ordered list that marks the current step', async () => {
    window.multissh = {
      sshTunnelList: vi.fn().mockResolvedValue([]),
      onSshTunnelEvent: vi.fn(() => () => undefined),
      sshTunnelCheckPort: vi.fn().mockResolvedValue(true),
    } as unknown as typeof window.multissh;
    render(
      <ConfirmProvider>
        <SSHTunnelsModal connection={connection} open onClose={vi.fn()} />
      </ConfirmProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: /New Tunnel/ }));

    const progress = screen.getByRole('list', { name: 'Progress' });
    const steps = within(progress).getAllByRole('listitem');
    expect(steps.map((li) => li.textContent?.trim())).toEqual(['1Type', '2Details', '3Done']);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    expect(steps[1]).not.toHaveAttribute('aria-current');

    // Pick the first tunnel type: the wizard moves to the second step
    const typeButton = screen.getByRole('button', { name: /Reach a service beyond the server/ });
    fireEvent.click(typeButton);
    expect(typeButton).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      const items = within(screen.getByRole('list', { name: 'Progress' })).getAllByRole('listitem');
      expect(items[1]).toHaveAttribute('aria-current', 'step');
      expect(items[0]).not.toHaveAttribute('aria-current');
      // The finished step says so beyond its check mark
      expect(items[0]).toHaveTextContent('(completed)');
    });
  });
});

