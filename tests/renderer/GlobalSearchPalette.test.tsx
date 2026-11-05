// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { GlobalSearchPalette } from '../../src/renderer/src/components/GlobalSearchPalette';
import type { AppTab } from '../../src/renderer/src/lib/tabs';

const ssh = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  host: `${id}.example.com`,
  username: 'deploy',
  authType: 'password',
  ...over,
});

interface Setup {
  personal?: { ssh: unknown[]; s3: unknown[] };
  vaults?: unknown[];
  payload?: { ssh: unknown[]; s3: unknown[] } | null;
  tabs?: AppTab[];
  shortcuts?: Record<string, string>;
}

function setup({ personal, vaults = [], payload = null, tabs = [], shortcuts }: Setup = {}) {
  const multissh = {
    profilesGet: vi.fn().mockResolvedValue(
      personal ?? {
        ssh: [
          ssh('web-01', { tags: ['prod', 'web'], lastUsedAt: '2026-10-29 10:00', password: 'hunter2' }), // pragma: allowlist secret
          ssh('db-01', { tags: ['prod', 'db'] }),
        ],
        s3: [{ id: 'assets', name: 'assets', region: 'eu-north-1' }],
      }
    ),
    teamVaultList: vi.fn().mockResolvedValue(vaults),
    teamVaultGetPayload: vi.fn().mockResolvedValue(payload),
    settingsGet: vi.fn().mockResolvedValue({}),
    profilesSaveSSH: vi.fn().mockResolvedValue(undefined),
    profilesSaveS3: vi.fn().mockResolvedValue(undefined),
  };
  (window as unknown as { multissh: unknown }).multissh = multissh;
  const handlers = {
    onClose: vi.fn(),
    onConnectSSH: vi.fn(),
    onOpenSFTP: vi.fn(),
    onConnectS3: vi.fn(),
    onSelectTab: vi.fn(),
    onOpenConnectionManager: vi.fn(),
    onRunAction: vi.fn(),
    onConnectSystem: vi.fn(),
  };
  render(<GlobalSearchPalette tabs={tabs} shortcuts={shortcuts} {...handlers} />);
  return { multissh, handlers, input: screen.getByRole('combobox') };
}

const type = (input: HTMLElement, text: string) => fireEvent.change(input, { target: { value: text } });
const options = () => screen.queryAllByRole('option');
const optionTexts = () => options().map((o) => o.textContent ?? '');

describe('GlobalSearchPalette', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    cleanup();
    delete (window as unknown as { multissh?: unknown }).multissh;
  });

  it('opens as a modal dialog with the search field focused', async () => {
    const { input } = setup();
    expect(screen.getByRole('dialog', { name: 'Search' })).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(input).toHaveFocus());
  });

  it('shows the recent profiles and the open tabs before anything is typed', async () => {
    setup({ tabs: [{ id: 't1', type: 'terminal', title: 'My shell' } as AppTab] });
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(optionTexts()[0]).toContain('web-01');
    expect(optionTexts()[1]).toContain('My shell');
  });

  it('finds profiles as you type, also by tag, and says when nothing matches', async () => {
    const { input } = setup();
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    type(input, '#db');
    expect(optionTexts()).toHaveLength(1);
    expect(optionTexts()[0]).toContain('db-01');
    type(input, 'zzz');
    expect(screen.getByText('No matches.')).toBeInTheDocument();
  });

  it('moves the selection with the arrow keys, wrapping around, and tells assistive technology which row is active', async () => {
    const { input } = setup();
    type(input, 'prod');
    await waitFor(() => expect(options()).toHaveLength(2));
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options()[0].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options()[1].id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('connects a personal profile on Enter, stamping and saving its last-used time first, then closes', async () => {
    const { input, multissh, handlers } = setup();
    type(input, 'db-01');
    await waitFor(() => expect(optionTexts()[0]).toContain('db-01'));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(handlers.onConnectSSH).toHaveBeenCalledTimes(1));
    const connected = handlers.onConnectSSH.mock.calls[0][0];
    expect(connected).toMatchObject({ id: 'db-01', lastUsedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/) });
    expect(multissh.profilesSaveSSH).toHaveBeenCalledWith(connected);
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('opens SFTP instead on Shift+Enter', async () => {
    const { input, handlers } = setup();
    type(input, 'db-01');
    await waitFor(() => expect(optionTexts()[0]).toContain('db-01'));
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(handlers.onOpenSFTP).toHaveBeenCalledTimes(1));
    expect(handlers.onOpenSFTP.mock.calls[0][0]).toMatchObject({ id: 'db-01' });
    expect(handlers.onConnectSSH).not.toHaveBeenCalled();
  });

  it('connects an S3 profile, and ignores Shift+Enter on it', async () => {
    const { input, handlers, multissh } = setup();
    type(input, 'assets');
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await Promise.resolve();
    expect(handlers.onConnectS3).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(handlers.onConnectS3).toHaveBeenCalledWith(expect.objectContaining({ id: 'assets' })));
    expect(multissh.profilesSaveS3).toHaveBeenCalled();
  });

  it('connects a Team Vault profile with its vault reference and never writes its last-used time', async () => {
    const { input, handlers, multissh } = setup({
      personal: { ssh: [], s3: [] },
      vaults: [{ exists: true, vaultId: 'v1', vaultName: 'Prod - Team', unlocked: true, filePath: '' }],
      payload: { ssh: [ssh('shared-web', { tags: ['prod'] })], s3: [] },
    });
    type(input, 'shared');
    await waitFor(() => expect(options()).toHaveLength(1));
    expect(optionTexts()[0]).toContain('Prod - Team');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(handlers.onConnectSSH).toHaveBeenCalledTimes(1));
    expect(handlers.onConnectSSH.mock.calls[0][0]).toMatchObject({
      id: 'shared-web',
      teamVaultProfileRef: { vaultId: 'v1', profileId: 'shared-web' },
    });
    expect(handlers.onConnectSSH.mock.calls[0][0].lastUsedAt).toBeUndefined();
    expect(multissh.profilesSaveSSH).not.toHaveBeenCalled();
  });

  it('switches to an open tab', async () => {
    const { input, handlers } = setup({ tabs: [{ id: 't9', type: 'terminal', title: 'Build box' } as AppTab] });
    type(input, 'build');
    await waitFor(() => expect(options()).toHaveLength(1));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(handlers.onSelectTab).toHaveBeenCalledWith('t9'));
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('offers a one-off connection for user@host, SSH on Enter and SFTP on Shift+Enter', async () => {
    const { input, handlers, multissh } = setup();
    type(input, 'alice@new-host:2222');
    expect(optionTexts()[0]).toContain('Connect to alice@new-host:2222');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(handlers.onConnectSSH).toHaveBeenCalledTimes(1));
    expect(handlers.onConnectSSH.mock.calls[0][0]).toMatchObject({ host: 'new-host', port: 2222, username: 'alice' });
    expect(multissh.profilesSaveSSH).not.toHaveBeenCalled();

    await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(handlers.onOpenSFTP).toHaveBeenCalledTimes(1));
  });

  it('lists a locked Team Vault and opens Connection Manager when it is chosen', async () => {
    const { handlers, input } = setup({
      personal: { ssh: [], s3: [] },
      vaults: [{ exists: true, vaultId: 'v2', vaultName: 'Infra', unlocked: false, filePath: '' }],
    });
    await waitFor(() => expect(optionTexts()[0]).toContain('Infra'));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(handlers.onOpenConnectionManager).toHaveBeenCalledTimes(1));
    expect(handlers.onClose).toHaveBeenCalled();
  });

  it('cycles the type filter with Tab and narrows the list', async () => {
    const { input } = setup({ tabs: [{ id: 't1', type: 'terminal', title: 'web shell' } as AppTab] });
    type(input, 'web');
    await waitFor(() => expect(options()).toHaveLength(2));
    const group = screen.getByRole('group', { name: 'Show' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(within(group).getByRole('button', { name: 'Profiles' })).toHaveAttribute('aria-pressed', 'true');
    expect(optionTexts()).toHaveLength(1);
    expect(optionTexts()[0]).toContain('web-01');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(within(group).getByRole('button', { name: 'Open tabs' })).toHaveAttribute('aria-pressed', 'true');
    expect(optionTexts()[0]).toContain('web shell');
  });

  describe('actions (>)', () => {
    it('lists the actions with their key combinations when the input is a lone >', async () => {
      const { input } = setup({ shortcuts: { newTerminal: 'Ctrl+Alt+T' } });
      await waitFor(() => expect(options().length).toBeGreaterThan(0));
      type(input, '>');
      expect(optionTexts()).toHaveLength(7);
      const terminal = optionTexts().find((t) => t.includes('New Terminal'))!;
      expect(terminal).toContain('Ctrl+Alt+T');
      expect(screen.getByText('Actions')).toBeInTheDocument();
    });

    it('narrows them as you type and runs the chosen one on Enter, then closes', async () => {
      const { input, handlers } = setup();
      type(input, '>settings');
      await waitFor(() => expect(optionTexts()[0]).toContain('Settings'));
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(handlers.onRunAction).toHaveBeenCalledWith('openSettings'));
      expect(handlers.onClose).toHaveBeenCalled();
      expect(handlers.onConnectSSH).not.toHaveBeenCalled();
    });

    it('says Enter runs the action and hides the type filter, which does not apply to actions', async () => {
      const { input } = setup();
      const hint = () => screen.getByText('close').parentElement!.parentElement!.textContent ?? '';
      expect(screen.getByRole('group', { name: 'Show' })).toBeInTheDocument();
      expect(hint()).toContain('connect');
      expect(hint()).toContain('SFTP');
      type(input, '>');
      expect(screen.queryByRole('group', { name: 'Show' })).not.toBeInTheDocument();
      expect(hint()).toContain('run');
      expect(hint()).not.toContain('connect');
      expect(hint()).not.toContain('SFTP');
      expect(hint()).not.toContain('filter');
      type(input, '');
      expect(screen.getByRole('group', { name: 'Show' })).toBeInTheDocument();
    });

    it('does not list the actions among the ordinary results', async () => {
      const { input } = setup();
      type(input, 'new');
      expect(optionTexts().join(' ')).not.toContain('New Terminal');
    });

    it('ignores Shift+Enter on an action instead of running it as something else', async () => {
      const { input, handlers } = setup();
      type(input, '>new terminal');
      await waitFor(() => expect(optionTexts()[0]).toContain('New Terminal'));
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      await waitFor(() => expect(handlers.onRunAction).toHaveBeenCalledWith('newTerminal'));
      expect(handlers.onOpenSFTP).not.toHaveBeenCalled();
    });
  });

  it('closes on Escape and from the close button and the backdrop', async () => {
    const { handlers } = setup();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('global-search-palette'));
    expect(handlers.onClose).toHaveBeenCalledTimes(3);
  });

  describe('systems', () => {
    const shop = {
      ssh: [
        ssh('shop-web', { system: { name: 'Shop' }, group: 'Prod' }),
        ssh('shop-db', { system: { name: 'shop', startDirectory: '/data' }, group: 'Prod' }),
        ssh('blog'),
      ],
      s3: [],
    };

    it('lists a system as one row with its number of servers, next to its servers', async () => {
      const { input } = setup({ personal: shop });
      type(input, 'shop');
      await waitFor(() => expect(options()).toHaveLength(3));
      expect(optionTexts().some((t) => t.includes('System · 2 servers'))).toBe(true);
    });

    it('finds the servers of a system by the system name, not only their own names', async () => {
      const { input } = setup({ personal: { ssh: [ssh('a1', { system: { name: 'Billing' } }), ssh('zz')], s3: [] } });
      type(input, 'billing');
      await waitFor(() => expect(options().length).toBeGreaterThan(0));
      expect(optionTexts().some((t) => t.startsWith('SSH') && t.includes('a1'))).toBe(true);
      expect(optionTexts().some((t) => t.includes('zz'))).toBe(false);
    });

    it('connects to every server of the system on Enter, passing the source, and closes', async () => {
      const { input, handlers } = setup({ personal: shop });
      type(input, 'shop');
      await waitFor(() => expect(options().length).toBeGreaterThan(0));
      const systemIndex = optionTexts().findIndex((t) => t.includes('System · 2 servers'));
      for (let i = 0; i < systemIndex; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(handlers.onConnectSystem).toHaveBeenCalledTimes(1));
      const [members, source] = handlers.onConnectSystem.mock.calls[0];
      expect(members.map((m: { id: string }) => m.id)).toEqual(['shop-db', 'shop-web']);
      expect(source).toBe('personal');
      expect(handlers.onClose).toHaveBeenCalled();
      expect(handlers.onConnectSSH).not.toHaveBeenCalled();
    });

    it('does nothing on Shift+Enter, since a system has no SFTP', async () => {
      const { input, handlers } = setup({ personal: shop });
      type(input, 'shop');
      await waitFor(() => expect(options().length).toBeGreaterThan(0));
      const systemIndex = optionTexts().findIndex((t) => t.includes('System · 2 servers'));
      for (let i = 0; i < systemIndex; i++) fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
      expect(handlers.onConnectSystem).not.toHaveBeenCalled();
      expect(handlers.onClose).not.toHaveBeenCalled();
    });
  });

  it('never puts a stored secret on the page', async () => {
    const { input } = setup();
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    type(input, 'web');
    expect(document.body.innerHTML).not.toContain('hunter2');
  });
});
