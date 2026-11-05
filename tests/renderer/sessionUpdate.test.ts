// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import type { SessionData } from '../../src/shared/types/session';
import { updateSession } from '../../src/renderer/src/lib/sessionUpdate';
import { useSessionPersistence } from '../../src/renderer/src/lib/useSessionPersistence';

const tab = (id: string) => ({ id, type: 'terminal', title: id }) as never;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session store whose reads and writes take time, like IPC does. */
function fakeStore(initial: SessionData | null) {
  let stored = initial;
  const sessionGet = vi.fn(async () => {
    const snapshot = stored && structuredClone(stored);
    await delay(5);
    return snapshot;
  });
  const sessionSave = vi.fn(async (next: SessionData) => {
    await delay(5);
    stored = structuredClone(next);
  });
  window.multissh = { sessionGet, sessionSave } as unknown as typeof window.multissh;
  return { read: () => stored, sessionGet, sessionSave };
}

afterEach(() => cleanup());

describe('updateSession', () => {
  it('keeps both parts when the tabs and the pane state are saved at the same time', async () => {
    const store = fakeStore({ tabs: [], activeTabId: '', lastPaths: {} });

    // Started together, like opening a file manager tab does: without the queue both read the empty
    // session and the one that writes last drops the other's part.
    await Promise.all([
      updateSession((c) => ({ ...c!, tabs: [tab('fm-1')], activeTabId: 'fm-1' })),
      updateSession((c) => ({ ...c!, lastPaths: { local: '/home/alice' } })),
    ]);

    expect(store.read()).toMatchObject({ tabs: [{ id: 'fm-1' }], activeTabId: 'fm-1', lastPaths: { local: '/home/alice' } });
  });

  it('runs the updates in the order they were asked for', async () => {
    const store = fakeStore({ tabs: [], activeTabId: '' });
    await Promise.all(['a', 'b', 'c'].map((id) => updateSession((c) => ({ ...c!, activeTabId: id }))));
    expect(store.read()!.activeTabId).toBe('c');
  });

  it('goes on with the next update when one fails', async () => {
    const store = fakeStore({ tabs: [], activeTabId: '' });
    store.sessionSave.mockRejectedValueOnce(new Error('disk full'));
    const first = updateSession((c) => ({ ...c!, activeTabId: 'x' }));
    const second = updateSession((c) => ({ ...c!, activeTabId: 'y' }));
    await expect(first).rejects.toThrow('disk full');
    await second;
    expect(store.read()!.activeTabId).toBe('y');
  });

  it('passes null when nothing is stored yet, and does nothing when there is no session API', async () => {
    const store = fakeStore(null);
    await updateSession((c) => {
      expect(c).toBeNull();
      return { tabs: [], activeTabId: '' };
    });
    expect(store.read()).toEqual({ tabs: [], activeTabId: '' });

    window.multissh = {} as unknown as typeof window.multissh;
    await expect(updateSession(() => ({ tabs: [], activeTabId: '' }))).resolves.toBeUndefined();
  });
});

describe('useSessionPersistence', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('tries the restore once more, and restores normally when that works', async () => {
    const saved = { tabs: [{ id: 't1', type: 'terminal', title: 'T' }], activeTabId: 't1' };
    const sessionGet = vi.fn().mockRejectedValueOnce(new Error('ipc hiccup')).mockResolvedValue(saved);
    const sessionSave = vi.fn().mockResolvedValue(undefined);
    window.multissh = { sessionGet, sessionSave } as unknown as typeof window.multissh;
    const setTabs = vi.fn();

    const { result } = renderHook(() => useSessionPersistence([tab('t1')], 't1', setTabs, vi.fn()));

    await waitFor(() => expect(result.current).toBe(true));
    expect(sessionGet.mock.calls.length).toBeGreaterThanOrEqual(2); // the failed read and its retry
    expect(setTabs).toHaveBeenCalled();
    await waitFor(() => expect(sessionSave).toHaveBeenCalled());
  });

  it('opens the app when the saved session cannot be read, and does not save over it', async () => {
    const sessionGet = vi.fn().mockRejectedValue(new Error('ipc failed'));
    const sessionSave = vi.fn().mockResolvedValue(undefined);
    window.multissh = { sessionGet, sessionSave } as unknown as typeof window.multissh;

    const { result } = renderHook(() => useSessionPersistence([], '', vi.fn(), vi.fn()));

    await waitFor(() => expect(result.current).toBe(true));
    await delay(20);
    expect(sessionSave).not.toHaveBeenCalled();
  });

  it('restores the saved tabs and then saves changes, keeping the other parts of the session', async () => {
    const store = fakeStore({ tabs: [{ id: 't1', type: 'terminal', title: 'T' } as never], activeTabId: 't1', lastPaths: { local: '/x' } });
    const setTabs = vi.fn();
    const setActive = vi.fn();

    const { result } = renderHook(() => useSessionPersistence([tab('t1')], 't1', setTabs, setActive));

    await waitFor(() => expect(result.current).toBe(true));
    expect(setTabs).toHaveBeenCalled();
    expect(setActive).toHaveBeenCalledWith('t1');
    await waitFor(() => expect(store.sessionSave).toHaveBeenCalled());
    expect(store.read()!.lastPaths).toEqual({ local: '/x' });
  });
});
