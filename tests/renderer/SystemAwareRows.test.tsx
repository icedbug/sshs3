// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SystemAwareRows } from '../../src/renderer/src/components/ConnectionModal/SystemAwareRows';
import type { SystemProfile } from '../../src/renderer/src/lib/systemGrouping';

afterEach(cleanup);

const p = (id: string, name: string, system?: string): SystemProfile => ({ id, name, ...(system ? { system: { name: system } } : {}) });

function setup(profiles: SystemProfile[], over: Partial<React.ComponentProps<typeof SystemAwareRows<SystemProfile>>> = {}) {
  const onConnectSystem = vi.fn();
  const onToggle = vi.fn();
  render(
    <SystemAwareRows
      profiles={profiles}
      source="personal"
      renderProfile={(profile) => <div key={profile.id} data-testid={`row-${profile.id}`}>{profile.name}</div>}
      onConnectSystem={onConnectSystem}
      collapsed={{}}
      onToggle={onToggle}
      {...over}
    />
  );
  return { onConnectSystem, onToggle };
}

describe('SystemAwareRows', () => {
  it('draws profiles that belong to no system exactly as a plain list, in order', () => {
    setup([p('1', 'b'), p('2', 'a')]);
    expect(screen.getAllByTestId(/^row-/).map((el) => el.textContent)).toEqual(['b', 'a']);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('draws a system as one row with its servers indented below it, by name', () => {
    setup([p('1', 'web', 'shop'), p('2', 'db', 'shop')]);
    expect(screen.getByText('shop')).toBeInTheDocument();
    expect(screen.getByText('2 servers')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'shop' });
    expect(within(group).getAllByTestId(/^row-/).map((el) => el.textContent)).toEqual(['db', 'web']);
  });

  it('says "1 server" for a system with one', () => {
    setup([p('1', 'only', 'shop')]);
    expect(screen.getByText('1 server')).toBeInTheDocument();
  });

  it('lists the systems before the loose profiles', () => {
    setup([p('1', 'loose'), p('2', 'web', 'shop')]);
    const order = screen.getAllByTestId(/^row-/).map((el) => el.textContent);
    expect(order).toEqual(['web', 'loose']);
  });

  it('connects to every server of the system, passing the source', () => {
    const { onConnectSystem } = setup([p('1', 'web', 'shop'), p('2', 'db', 'shop'), p('3', 'other', 'blog')], { source: 'vault-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect all servers in shop' }));
    expect(onConnectSystem).toHaveBeenCalledTimes(1);
    const [members, source] = onConnectSystem.mock.calls[0];
    expect(members.map((m: SystemProfile) => m.id)).toEqual(['2', '1']);
    expect(source).toBe('vault-1');
  });

  it('has no Connect all button when connecting is not offered', () => {
    setup([p('1', 'web', 'shop')], { onConnectSystem: undefined });
    expect(screen.queryByRole('button', { name: /Connect all/ })).not.toBeInTheDocument();
  });

  it('collapses and expands with the chevron button, which says what it will do', () => {
    const { onToggle } = setup([p('1', 'web', 'shop')]);
    const button = screen.getByRole('button', { name: 'Collapse shop' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledWith('sys-personal-shop');
  });

  it('hides the servers of a collapsed system but still offers Connect all', () => {
    setup([p('1', 'web', 'shop')], { collapsed: { 'sys-personal-shop': true } });
    expect(screen.queryByTestId('row-1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand shop' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Connect all servers in shop' })).toBeInTheDocument();
  });

  it('keeps the collapsed state of one source apart from another with a system of the same name', () => {
    setup([p('1', 'web', 'shop')], { source: 'vault-2', collapsed: { 'sys-personal-shop': true } });
    expect(screen.getByTestId('row-1')).toBeInTheDocument();
  });

  it('treats system names that differ only in case as one system', () => {
    setup([p('1', 'a', 'Shop'), p('2', 'b', 'shop')]);
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByText('2 servers')).toBeInTheDocument();
  });

  it('has no Rename or Ungroup buttons when editing is not offered', () => {
    setup([p('1', 'web', 'shop')]);
    expect(screen.queryByRole('button', { name: 'Rename shop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ungroup shop' })).not.toBeInTheDocument();
  });

  it('renames a system in place: Enter hands over the servers and the new name', () => {
    const onRenameSystem = vi.fn();
    setup([p('1', 'web', 'shop'), p('2', 'db', 'shop')], { onRenameSystem });
    fireEvent.click(screen.getByRole('button', { name: 'Rename shop' }));
    const field = screen.getByRole('textbox', { name: 'New name for shop' });
    expect(field).toHaveValue('shop');
    // The old name is selected, so typing replaces it.
    expect((field as HTMLInputElement).selectionStart).toBe(0);
    expect((field as HTMLInputElement).selectionEnd).toBe(4);
    fireEvent.change(field, { target: { value: 'webshop' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onRenameSystem).toHaveBeenCalledTimes(1);
    expect(onRenameSystem.mock.calls[0][0].map((m: SystemProfile) => m.id)).toEqual(['2', '1']);
    expect(onRenameSystem.mock.calls[0][1]).toBe('webshop');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps what was typed when the field is left, and renames only once', () => {
    const onRenameSystem = vi.fn();
    setup([p('1', 'web', 'shop')], { onRenameSystem });
    fireEvent.click(screen.getByRole('button', { name: 'Rename shop' }));
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'webshop' } });
    fireEvent.blur(field);
    expect(onRenameSystem).toHaveBeenCalledTimes(1);
    expect(onRenameSystem.mock.calls[0][1]).toBe('webshop');
  });

  it('does not rename a second time when Enter closes the field and it then loses focus', () => {
    const onRenameSystem = vi.fn();
    setup([p('1', 'web', 'shop')], { onRenameSystem });
    fireEvent.click(screen.getByRole('button', { name: 'Rename shop' }));
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'webshop' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);
    expect(onRenameSystem).toHaveBeenCalledTimes(1);
  });

  it('can be renamed again after an earlier rename', () => {
    const onRenameSystem = vi.fn();
    setup([p('1', 'web', 'shop')], { onRenameSystem });
    for (const value of ['one', 'two']) {
      fireEvent.click(screen.getByRole('button', { name: 'Rename shop' }));
      const field = screen.getByRole('textbox');
      fireEvent.change(field, { target: { value } });
      fireEvent.keyDown(field, { key: 'Enter' });
    }
    expect(onRenameSystem.mock.calls.map((c) => c[1])).toEqual(['one', 'two']);
  });

  it('Escape closes the rename field without renaming', () => {
    const onRenameSystem = vi.fn();
    setup([p('1', 'web', 'shop')], { onRenameSystem });
    fireEvent.click(screen.getByRole('button', { name: 'Rename shop' }));
    const field = screen.getByRole('textbox');
    fireEvent.change(field, { target: { value: 'changed' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    fireEvent.blur(field);
    expect(onRenameSystem).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('hands the servers of the system over when it is ungrouped', () => {
    const onUngroupSystem = vi.fn();
    setup([p('1', 'web', 'shop'), p('2', 'other', 'blog')], { onUngroupSystem });
    fireEvent.click(screen.getByRole('button', { name: 'Ungroup shop' }));
    expect(onUngroupSystem.mock.calls[0][0].map((m: SystemProfile) => m.id)).toEqual(['1']);
  });

  it('draws nothing for no profiles', () => {
    const { container } = render(
      <SystemAwareRows profiles={[]} source="personal" renderProfile={() => null} collapsed={{}} onToggle={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
