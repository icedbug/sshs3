// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TeamProfileTreeList } from '../../src/renderer/src/components/ConnectionModal/TeamProfileTreeList';
import { ConfirmProvider } from '../../src/renderer/src/components/ConfirmDialog';
import type { TeamVaultPayload, TeamVaultStatus } from '../../src/shared/types/teamVault';

const lockedStatus: TeamVaultStatus = {
  exists: true,
  vaultId: 'v1',
  vaultName: 'Acme',
  unlocked: false,
  filePath: '/tmp/v1',
  selfRecipientId: 'age1alice',
  selfIdentityFilePath: '/home/alice/key.txt',
} as TeamVaultStatus;

const payload: TeamVaultPayload = {
  ssh: [{ id: 'p1', name: 'web-1', host: 'web-1.example.com', username: 'root', authType: 'password', group: 'Acme Infra' } as never],
  s3: [],
  folders: ['Acme Infra'],
} as TeamVaultPayload;

function setApi(over: Record<string, unknown> = {}) {
  window.multissh = {
    teamVaultList: vi.fn().mockResolvedValue([lockedStatus]),
    teamVaultGetStatus: vi.fn().mockResolvedValue(lockedStatus),
    teamVaultGetPayload: vi.fn().mockResolvedValue(payload),
    teamVaultUnlock: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as typeof window.multissh;
}

function renderList(props: Partial<React.ComponentProps<typeof TeamProfileTreeList>> = {}) {
  return render(
    <ConfirmProvider>
      <TeamProfileTreeList
        tab="ssh"
        query=""
        activeVaultId="v1"
        setEditing={vi.fn()}
        onNewProfile={vi.fn()}
        onVaultsMetaChange={vi.fn()}
        {...props}
      />
    </ConfirmProvider>
  );
}

afterEach(() => cleanup());

describe('TeamProfileTreeList errors', () => {
  beforeEach(() => setApi());

  it('keeps the unlock form after a failed unlock, with a message that can be dismissed', async () => {
    window.multissh.teamVaultUnlock = vi.fn().mockRejectedValue(new Error('Wrong passphrase'));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: /Unlock as age1alice/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Wrong passphrase');
    // Still there to try again: the form was replaced by the message before.
    expect(screen.getByRole('button', { name: /Unlock as age1alice/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the message when the next attempt is made', async () => {
    const unlock = vi.fn().mockRejectedValueOnce(new Error('Wrong passphrase')).mockResolvedValue(undefined);
    window.multissh.teamVaultUnlock = unlock;
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: /Unlock as age1alice/ }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /Unlock as age1alice/ }));

    await waitFor(() => expect(unlock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('offers a retry when the list of teams cannot be loaded', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('keyring locked')).mockResolvedValue([lockedStatus]);
    window.multissh.teamVaultList = list;
    renderList();

    expect(await screen.findByRole('alert')).toHaveTextContent('keyring locked');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: /Unlock as age1alice/ })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('TeamProfileTreeList folder position', () => {
  const unlocked = { ...lockedStatus, unlocked: true } as TeamVaultStatus;
  beforeEach(() => setApi({ teamVaultList: vi.fn().mockResolvedValue([unlocked]), teamVaultGetStatus: vi.fn().mockResolvedValue(unlocked) }));

  it('reports where the user went and shows the position it is given, so it survives a remount', async () => {
    const onFolderPathChange = vi.fn();
    const first = renderList({ folderPaths: {}, onFolderPathChange });

    fireEvent.click(await screen.findByRole('button', { name: 'Open Acme Infra' }));
    expect(onFolderPathChange).toHaveBeenCalledWith('ssh/v1', ['Acme Infra']);
    first.unmount();

    // A new instance (the list is unmounted while a profile is edited) opens in that folder.
    renderList({ folderPaths: { 'ssh/v1': ['Acme Infra'] }, onFolderPathChange });
    expect(await screen.findByText('web-1')).toBeInTheDocument();
  });

  it('keeps a position per tab: the S3 tab does not inherit the SSH tab\'s folder', async () => {
    renderList({ tab: 's3', folderPaths: { 'ssh/v1': ['Acme Infra'] } });
    await screen.findByText(/No profiles|New Profile/);
    expect(screen.queryByText('web-1')).not.toBeInTheDocument();
  });
});

describe('TeamProfileTreeList folder sidebar', () => {
  const unlocked = { ...lockedStatus, unlocked: true } as TeamVaultStatus;
  const nested = {
    ssh: [
      { id: 'p1', name: 'web-1', host: 'web-1.example.com', username: 'root', authType: 'password', group: 'Acme Infra' },
      { id: 'p2', name: 'node-1', host: 'node-1.example.com', username: 'root', authType: 'password', group: 'Acme Infra/Cluster A' },
    ],
    s3: [],
    folders: ['Acme Infra', 'Acme Infra/Cluster A'],
  } as unknown as TeamVaultPayload;

  beforeEach(() =>
    setApi({
      teamVaultList: vi.fn().mockResolvedValue([unlocked]),
      teamVaultGetStatus: vi.fn().mockResolvedValue(unlocked),
      teamVaultGetPayload: vi.fn().mockResolvedValue(nested),
    })
  );

  it('shows the folder tree beside the list, with the number of profiles in each folder', async () => {
    renderList();
    const tree = await screen.findByRole('navigation', { name: 'Folders' });
    expect(tree).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Acme Infra (2 profiles)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All folders (2 profiles)' })).toBeInTheDocument();
  });

  it('browses a folder picked in the tree with the same position the breadcrumb uses', async () => {
    const onFolderPathChange = vi.fn();
    renderList({ folderPaths: {}, onFolderPathChange });
    fireEvent.click(await screen.findByRole('button', { name: 'Acme Infra (2 profiles)' }));
    expect(onFolderPathChange).toHaveBeenCalledWith('ssh/v1', ['Acme Infra']);
  });

  it('highlights, and opens the tree down to, the folder the list is showing', async () => {
    renderList({ folderPaths: { 'ssh/v1': ['Acme Infra', 'Cluster A'] }, onFolderPathChange: vi.fn() });
    expect(await screen.findByRole('button', { name: 'Cluster A (1 profile)' })).toHaveAttribute('aria-current', 'page');
  });

  it('is not shown while searching, when the results are one flat list', async () => {
    renderList({ query: 'web' });
    await screen.findByText(/Search results for/);
    expect(screen.queryByRole('navigation', { name: 'Folders' })).not.toBeInTheDocument();
  });

  it('is not shown for a team without folders', async () => {
    window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({
      ssh: [{ id: 'p1', name: 'web-1', host: 'h', username: 'root', authType: 'password' }],
      s3: [],
      folders: [],
    });
    renderList();
    await screen.findByText('web-1');
    expect(screen.queryByRole('navigation', { name: 'Folders' })).not.toBeInTheDocument();
  });
});

describe('TeamProfileTreeList multi-select', () => {
  const unlocked = { ...lockedStatus, unlocked: true } as TeamVaultStatus;
  const loose = {
    ssh: [
      { id: 'p1', name: 'web-1', host: 'web-1.example.com', username: 'root', authType: 'password', hasPassword: true },
      { id: 'p2', name: 'web-2', host: 'web-2.example.com', username: 'root', authType: 'password', tags: ['web'] },
      { id: 'p3', name: 'db-1', host: 'db-1.example.com', username: 'root', authType: 'password' },
    ],
    s3: [],
    folders: ['Acme Infra'],
  } as unknown as TeamVaultPayload;
  let save: ReturnType<typeof vi.fn>;
  let getPayload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    save = vi.fn().mockResolvedValue(undefined);
    getPayload = vi.fn().mockResolvedValue(loose);
    setApi({
      teamVaultList: vi.fn().mockResolvedValue([unlocked]),
      teamVaultGetStatus: vi.fn().mockResolvedValue(unlocked),
      teamVaultGetPayload: getPayload,
      teamVaultSaveSSHProfile: save,
      teamVaultSaveS3Profile: vi.fn().mockResolvedValue(undefined),
    });
  });

  const select = async (...names: string[]) => {
    for (const name of names) fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${name}` }));
  };

  it('shows a checkbox on each shared profile and the action bar once some are selected', async () => {
    renderList();
    await select('web-1', 'db-1');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('moves the selected profiles into a folder through the vault, without the reference the list adds, then reloads', async () => {
    renderList();
    await select('web-1', 'web-2');
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Acme Infra/Cluster A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const saved = save.mock.calls.map(([, profile]) => profile);
    expect(saved.map((p) => p.id)).toEqual(['p1', 'p2']);
    for (const profile of saved) {
      expect(profile.group).toBe('Acme Infra/Cluster A');
      expect('teamVaultProfileRef' in profile).toBe(false);
    }
    expect(save.mock.calls[0][0]).toBe('v1');
    await waitFor(() => expect(getPayload).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Moved 2 profiles to "Acme Infra/Cluster A".')).toBeInTheDocument();
  });

  it('keeps what a member sees of a profile as it is: no secret is added back when saving', async () => {
    renderList();
    await select('web-1');
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Acme Infra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0][1];
    expect(saved).toMatchObject({ id: 'p1', hasPassword: true, group: 'Acme Infra' });
    expect(saved.password).toBeUndefined();
  });

  it('adds tags to the selected shared profiles', async () => {
    renderList();
    await select('web-2', 'db-1');
    fireEvent.click(screen.getByRole('button', { name: 'Add tags…' }));
    const input = screen.getByLabelText('Tags to add');
    fireEvent.change(input, { target: { value: 'prod' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[0][1]).toMatchObject({ id: 'p2', tags: ['prod', 'web'] });
    expect(save.mock.calls[1][1]).toMatchObject({ id: 'p3', tags: ['prod'] });
  });

  it('shows the error when the vault refuses a save, and keeps the selection', async () => {
    save.mockRejectedValue(new Error('Only a Team Vault admin can do that'));
    renderList();
    await select('web-1');
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Acme Infra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Only a Team Vault admin can do that');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('groups the selected shared profiles into a system through the vault, without the vault reference', async () => {
    renderList();
    await select('web-1', 'db-1');
    fireEvent.click(screen.getByRole('button', { name: 'Group as system…' }));
    fireEvent.change(screen.getByLabelText('System'), { target: { value: 'Stack' } });
    fireEvent.change(screen.getByLabelText('Folder (optional)'), { target: { value: 'Acme Infra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    for (const [vaultId, profile] of save.mock.calls) {
      expect(vaultId).toBe('v1');
      expect(profile).toMatchObject({ group: 'Acme Infra', system: { name: 'Stack' } });
      expect('teamVaultProfileRef' in profile).toBe(false);
    }
  });

  it('moves the whole system when one of its servers is moved to another folder', async () => {
    getPayload.mockResolvedValue({
      ssh: [
        { id: 'p1', name: 'web-1', host: 'h1', username: 'root', authType: 'password', system: { name: 'Stack' } },
        { id: 'p2', name: 'web-2', host: 'h2', username: 'root', authType: 'password', system: { name: 'Stack' } },
        { id: 'p3', name: 'db-1', host: 'h3', username: 'root', authType: 'password' },
      ],
      s3: [],
      folders: ['Acme Infra'],
    });
    renderList();
    await select('web-1');
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Acme Infra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls.map(([, p]) => p.id)).toEqual(['p1', 'p2']);
  });

  describe('managing a shared system', () => {
    beforeEach(() => {
      getPayload.mockResolvedValue({
        ssh: [
          { id: 'p1', name: 'web-1', host: 'h1', username: 'root', authType: 'password', system: { name: 'Stack' } },
          { id: 'p2', name: 'web-2', host: 'h2', username: 'root', authType: 'password', system: { name: 'Stack', startDirectory: '/srv' } },
        ],
        s3: [],
        folders: [],
      });
    });

    it('renames it by saving each server through the vault', async () => {
      renderList();
      fireEvent.click(await screen.findByRole('button', { name: 'Rename Stack' }));
      const field = screen.getByRole('textbox', { name: 'New name for Stack' });
      fireEvent.change(field, { target: { value: 'Platform' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      expect(save.mock.calls.map(([vault, p]) => [vault, p.id, p.system])).toEqual([
        ['v1', 'p1', { name: 'Platform' }],
        ['v1', 'p2', { name: 'Platform', startDirectory: '/srv' }],
      ]);
    });

    it('ungroups it after asking, keeping the profiles', async () => {
      renderList();
      fireEvent.click(await screen.findByRole('button', { name: 'Ungroup Stack' }));
      expect(save).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole('button', { name: 'Ungroup' }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      for (const [, p] of save.mock.calls) expect('system' in p).toBe(false);
    });
  });

  it('does not offer grouping as a system on the S3 tab', async () => {
    getPayload.mockResolvedValue({ ssh: [], s3: [{ id: 'b1', name: 'bucket', region: 'r', accessKeyId: 'a', secretAccessKey: 'b' }], folders: [] }); // pragma: allowlist secret
    renderList({ tab: 's3' });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select bucket' }));
    expect(screen.queryByRole('button', { name: 'Group as system…' })).not.toBeInTheDocument();
  });

  it('starts with an empty selection on the S3 tab', async () => {
    const { rerender } = renderList();
    await select('web-1');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    rerender(
      <ConfirmProvider>
        <TeamProfileTreeList tab="s3" query="" activeVaultId="v1" setEditing={vi.fn()} onNewProfile={vi.fn()} onVaultsMetaChange={vi.fn()} />
      </ConfirmProvider>
    );
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument());
  });

  it('offers the folders of the team as destinations', async () => {
    const { container } = renderList();
    await select('web-1');
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder…' }));
    const values = Array.from(container.querySelectorAll('datalist option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('Acme Infra');
  });
});

describe('TeamProfileTreeList systems', () => {
  const unlocked = { ...lockedStatus, unlocked: true } as TeamVaultStatus;
  const host = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    host: `${name}.example.com`,
    username: 'root',
    authType: 'password',
    ...extra,
  });
  const withSystems = {
    ssh: [
      host('a', 'shop-web', { system: { name: 'shop' }, hasPassword: true }),
      host('b', 'shop-db', { system: { name: 'shop', startDirectory: '/var/lib' } }),
      host('c', 'blog'),
    ],
    s3: [],
    folders: [],
  } as unknown as TeamVaultPayload;

  beforeEach(() =>
    setApi({
      teamVaultList: vi.fn().mockResolvedValue([unlocked]),
      teamVaultGetStatus: vi.fn().mockResolvedValue(unlocked),
      teamVaultGetPayload: vi.fn().mockResolvedValue(withSystems),
    })
  );

  it('draws the shared servers of a system as one row with the servers below it', async () => {
    renderList();
    expect(await screen.findByText('2 servers')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'shop' });
    expect(group).toHaveTextContent('shop-db');
    expect(group).toHaveTextContent('shop-web');
    expect(screen.getByText('blog')).toBeInTheDocument();
  });

  it('connects to the system with the vault reference of every server, so the main process can add the secrets', async () => {
    const onConnectSystem = vi.fn();
    renderList({ onConnectSystem });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect all servers in shop' }));
    expect(onConnectSystem).toHaveBeenCalledTimes(1);
    const [members, source] = onConnectSystem.mock.calls[0];
    expect(source).toBe('v1');
    expect(members.map((m: { id: string }) => m.id)).toEqual(['b', 'a']);
    for (const member of members) expect(member.teamVaultProfileRef).toEqual({ vaultId: 'v1', profileId: member.id });
    expect(members[0].system).toEqual({ name: 'shop', startDirectory: '/var/lib' });
    expect(members.find((m: { id: string }) => m.id === 'a').password).toBeUndefined();
  });

  it('keeps the servers on one line each, without a system row, in search results', async () => {
    renderList({ query: 'shop' });
    await screen.findByText(/Search results for/);
    expect(screen.queryByText('2 servers')).not.toBeInTheDocument();
    expect(screen.getByText('shop-web')).toBeInTheDocument();
    expect(screen.getByText('shop-db')).toBeInTheDocument();
  });

  it('finds the servers of a system by the name of the system', async () => {
    renderList({ query: 'shop' });
    await screen.findByText(/Search results for/);
    expect(screen.queryByText('blog')).not.toBeInTheDocument();
  });

  it('does not draw systems on the S3 tab', async () => {
    renderList({ tab: 's3' });
    await screen.findByText(/No profiles|New Profile/);
    expect(screen.queryByText('2 servers')).not.toBeInTheDocument();
  });

  it('shows no system row when no server belongs to a system', async () => {
    window.multissh.teamVaultGetPayload = vi.fn().mockResolvedValue({ ssh: [host('c', 'blog')], s3: [], folders: [] });
    renderList();
    await screen.findByText('blog');
    expect(screen.queryByRole('button', { name: /Connect all/ })).not.toBeInTheDocument();
  });
});
