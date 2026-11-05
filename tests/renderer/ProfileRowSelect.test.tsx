// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SshProfileRow } from '../../src/renderer/src/components/ConnectionModal/SshProfileRows';
import { S3ProfileRow } from '../../src/renderer/src/components/ConnectionModal/S3ProfileRows';
import { TeamS3ProfileRow, TeamSshProfileRow } from '../../src/renderer/src/components/ConnectionModal/TeamProfileRows';
import type { RowSelect } from '../../src/renderer/src/components/ConnectionModal/types';

afterEach(cleanup);

const ssh = { id: 'p1', name: 'web-01', host: 'web-01.example.com', username: 'u', authType: 'password' } as never;
const s3 = { id: 'b1', name: 'assets', region: 'eu-north-1', accessKeyId: 'a', secretAccessKey: 'b' } as never; // pragma: allowlist secret
const noop = vi.fn();

const sshProps = {
  profile: ssh,
  handleConnectSSH: noop,
  handleCloneSSH: noop,
  handleDeleteSSH: noop,
  setEditing: noop,
  setInstallKeyProfile: noop,
  setTunnelsProfile: noop,
};
const s3Props = { profile: s3, handleConnectS3: noop, handleCloneS3: noop, handleDeleteS3: noop, setEditing: noop };
const teamSshProps = { profile: ssh, handleCloneSSH: noop, handleDeleteSSH: noop, setEditing: noop };
const teamS3Props = { profile: s3, handleCloneS3: noop, handleDeleteS3: noop, setEditing: noop };

const rows: Array<[string, string, (select?: RowSelect) => React.ReactElement]> = [
  ['SSH row', 'web-01', (select) => <SshProfileRow {...sshProps} select={select} />],
  ['S3 row', 'assets', (select) => <S3ProfileRow {...s3Props} select={select} />],
  ['Team SSH row', 'web-01', (select) => <TeamSshProfileRow {...teamSshProps} select={select} />],
  ['Team S3 row', 'assets', (select) => <TeamS3ProfileRow {...teamS3Props} select={select} />],
];

describe.each(rows)('%s selection checkbox', (_label, name, make) => {
  it('has no checkbox when the list does not support selecting', () => {
    render(make());
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows a checkbox named after the profile, and toggles through the list', () => {
    const onToggle = vi.fn();
    render(make({ checked: false, anyChecked: false, onToggle }));
    const box = screen.getByRole('checkbox', { name: `Select ${name}` });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows it as checked when the profile is selected', () => {
    render(make({ checked: true, anyChecked: true, onToggle: vi.fn() }));
    expect(screen.getByRole('checkbox', { name: `Select ${name}` })).toBeChecked();
  });

  it('is hidden until the row is pointed at or focused, but visible once anything is selected', () => {
    const { rerender } = render(make({ checked: false, anyChecked: false, onToggle: vi.fn() }));
    const hidden = screen.getByRole('checkbox');
    expect(hidden).toHaveClass('opacity-0');
    expect(hidden.className).toContain('group-hover:opacity-100');
    expect(hidden.className).toContain('focus-visible:opacity-100');
    rerender(make({ checked: false, anyChecked: true, onToggle: vi.fn() }));
    expect(screen.getByRole('checkbox')).not.toHaveClass('opacity-0');
  });

  it('does not start a drag or a double-click connect when it is clicked', () => {
    render(make({ checked: false, anyChecked: false, onToggle: vi.fn() }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    const stop = vi.spyOn(click, 'stopPropagation');
    screen.getByRole('checkbox').dispatchEvent(click);
    expect(stop).toHaveBeenCalled();
  });
});
