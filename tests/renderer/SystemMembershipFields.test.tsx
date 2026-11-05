// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SystemMembershipFields } from '../../src/renderer/src/components/ConnectionModal/SystemMembershipFields';
import type { SSHSystemMembership, SSHTunnelConfig } from '../../src/shared/types/ssh';

afterEach(cleanup);

const tunnels: SSHTunnelConfig[] = [
  { id: 't1', name: 'Database', type: 'local', localPort: 5432, remoteHost: 'localhost', remotePort: 5432 },
  { id: 't2', name: 'Cache', type: 'local', localPort: 6379, remoteHost: 'localhost', remotePort: 6379 },
];

function setup(system?: SSHSystemMembership, over: Partial<React.ComponentProps<typeof SystemMembershipFields>> = {}) {
  const onChange = vi.fn();
  const utils = render(<SystemMembershipFields system={system} tunnels={tunnels} onChange={onChange} suggestions={['shop', 'blog']} {...over} />);
  return { ...utils, onChange };
}

describe('SystemMembershipFields', () => {
  it('shows only the system name while the server belongs to no system', () => {
    setup();
    expect(screen.getByLabelText('System (optional)')).toHaveValue('');
    expect(screen.queryByLabelText('Open a terminal to this server')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Start directory')).not.toBeInTheDocument();
  });

  it('offers the existing systems while typing the name', () => {
    const { container } = setup();
    const options = Array.from(container.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['shop', 'blog']);
  });

  it('joins a system when a name is typed', () => {
    const { onChange } = setup();
    fireEvent.change(screen.getByLabelText('System (optional)'), { target: { value: 'shop' } });
    expect(onChange).toHaveBeenCalledWith({ name: 'shop' });
  });

  it('leaves the system, and forgets what was set for it, when the name is cleared', () => {
    const { onChange } = setup({ name: 'shop', startDirectory: '/srv', tunnelIds: ['t1'] });
    fireEvent.change(screen.getByLabelText('System (optional)'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('shows what the server contributes once it is in a system', () => {
    setup({ name: 'shop', startDirectory: '/srv', tunnelIds: ['t2'] });
    expect(screen.getByLabelText('Open a terminal to this server')).toBeChecked();
    expect(screen.getByLabelText('Start directory')).toHaveValue('/srv');
    expect(screen.getByLabelText('Database')).not.toBeChecked();
    expect(screen.getByLabelText('Cache')).toBeChecked();
  });

  it('switches the terminal off and on, storing only the off state', () => {
    const { onChange, rerender } = setup({ name: 'shop' });
    fireEvent.click(screen.getByLabelText('Open a terminal to this server'));
    expect(onChange).toHaveBeenLastCalledWith({ name: 'shop', shell: false });
    rerender(<SystemMembershipFields system={{ name: 'shop', shell: false }} tunnels={tunnels} onChange={onChange} />);
    expect(screen.getByLabelText('Open a terminal to this server')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Open a terminal to this server'));
    expect(onChange).toHaveBeenLastCalledWith({ name: 'shop' });
  });

  it('sets and clears the start directory', () => {
    const { onChange } = setup({ name: 'shop', startDirectory: '/srv' });
    fireEvent.change(screen.getByLabelText('Start directory'), { target: { value: '/var/www' } });
    expect(onChange).toHaveBeenLastCalledWith({ name: 'shop', startDirectory: '/var/www' });
    fireEvent.change(screen.getByLabelText('Start directory'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ name: 'shop' });
  });

  it('picks the tunnels that are started with the system', () => {
    const { onChange } = setup({ name: 'shop', tunnelIds: ['t1'] });
    fireEvent.click(screen.getByLabelText('Cache'));
    expect(onChange).toHaveBeenLastCalledWith({ name: 'shop', tunnelIds: ['t1', 't2'] });
    fireEvent.click(screen.getByLabelText('Database'));
    expect(onChange).toHaveBeenLastCalledWith({ name: 'shop' });
  });

  it('has no tunnel list when the server has no tunnels', () => {
    setup({ name: 'shop' }, { tunnels: [] });
    expect(screen.queryByText('Tunnels to start')).not.toBeInTheDocument();
  });

  it('groups its fields so a screen reader announces them together', () => {
    setup({ name: 'shop' });
    expect(screen.getByRole('group', { name: 'System' })).toBeInTheDocument();
  });
});
