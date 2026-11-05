import { describe, it, expect } from 'vitest';
import {
  isEmptyUnconnectedTab,
  normalizeTab,
  sanitizeTabForSession,
  tabForNumber,
  type AppTab,
} from '../../src/renderer/src/lib/tabs';

describe('tabs helpers', () => {
  it('maps tab numbers 1..8 to that tab and 9 to the last tab', () => {
    const tabs = ['a', 'b', 'c'].map((id) => ({ id, type: 'terminal', title: id }) as AppTab);
    expect(tabForNumber(tabs, 1)?.id).toBe('a');
    expect(tabForNumber(tabs, 3)?.id).toBe('c');
    expect(tabForNumber(tabs, 4)).toBeNull();
    expect(tabForNumber(tabs, 9)?.id).toBe('c');
    expect(tabForNumber([], 9)).toBeNull();
    expect(tabForNumber(tabs, 0)).toBeNull();
  });

  it('does not persist the transient pane zoom in a saved session', () => {
    const tab = {
      id: 't1',
      type: 'terminal',
      title: 'T',
      paneTree: { type: 'leaf', id: 'a' },
      zoomedPaneId: 'a',
    } as AppTab;
    expect(sanitizeTabForSession(tab)).not.toHaveProperty('zoomedPaneId');
  });

  it('gives a terminal tab without a pane tree a single root leaf', () => {
    const tab = normalizeTab({ id: 't1', type: 'terminal', title: 'Terminal 1' } as AppTab);
    expect(tab.paneTree).toMatchObject({ type: 'leaf', id: 't1-root' });
  });

  it('leaves file manager tabs and tabs that already have a tree untouched', () => {
    const fm = { id: 'f1', type: 'filemanager', title: 'File Manager 1' } as AppTab;
    expect(normalizeTab(fm)).toBe(fm);
    const withTree = { id: 't1', type: 'terminal', title: 'T', paneTree: { type: 'leaf', id: 'x' } } as AppTab;
    expect(normalizeTab(withTree)).toBe(withTree);
  });

  it('treats a single not-yet-connected pane as empty, a connected or local one as not', () => {
    const base = { id: 't1', type: 'terminal', title: 'T' };
    expect(isEmptyUnconnectedTab({ ...base, paneTree: { type: 'leaf', id: 'a' } } as AppTab)).toBe(true);
    expect(isEmptyUnconnectedTab({ ...base, paneTree: { type: 'leaf', id: 'a', local: true } } as AppTab)).toBe(false);
    expect(
      isEmptyUnconnectedTab({ ...base, paneTree: { type: 'leaf', id: 'a', config: { id: 'c' } } } as unknown as AppTab)
    ).toBe(false);
  });

  it('does not treat a pane that runs a Kubernetes shell or log view as empty, so connecting never replaces it', () => {
    const base = { id: 't1', type: 'terminal', title: 'T' };
    const target = { contextName: 'c', namespace: 'n', podName: 'p', containerName: 'x' };
    expect(isEmptyUnconnectedTab({ ...base, paneTree: { type: 'leaf', id: 'a', k8sTarget: target } } as AppTab)).toBe(false);
    expect(isEmptyUnconnectedTab({ ...base, paneTree: { type: 'leaf', id: 'a', k8sLogTarget: target } } as AppTab)).toBe(false);
  });

  it('strips credentials from the pane tree before a tab is saved', () => {
    const tab = {
      id: 't1',
      type: 'terminal',
      title: 'T',
      paneTree: {
        type: 'leaf',
        id: 'a',
        config: { id: 'c', host: 'h', username: 'u', authType: 'password', password: 'secret', pin: '1234' }, // pragma: allowlist secret
      },
    } as unknown as AppTab;
    const saved = JSON.stringify(sanitizeTabForSession(tab));
    expect(saved).not.toContain('secret');
    expect(saved).not.toContain('1234');
    expect(saved).toContain('"host":"h"');
  });
  it('strips secrets from the connection a file manager tab was opened with (no pane tree)', () => {
    const tab = {
      id: 'fm1',
      type: 'filemanager',
      title: 'FM',
      initialSSHConfig: {
        id: 'c', host: 'h', username: 'u', authType: 'password',
        password: 'pw-secret', passphrase: 'pp-secret', pin: '9876', // pragma: allowlist secret
        proxy: { type: 'socks5', host: 'p', port: 1080, password: 'proxy-secret' }, // pragma: allowlist secret
      },
      initialS3Config: {
        id: 's', name: 'S', region: 'r', accessKeyId: 'AKIA',
        secretAccessKey: 's3-secret', sessionToken: 'tok-secret', // pragma: allowlist secret
      },
    } as unknown as AppTab;
    const saved = JSON.stringify(sanitizeTabForSession(tab));
    for (const secret of ['pw-secret', 'pp-secret', '9876', 'proxy-secret', 's3-secret', 'tok-secret']) {
      expect(saved).not.toContain(secret);
    }
    expect(saved).toContain('"host":"h"');
    expect(saved).toContain('"accessKeyId":"AKIA"');
    // The live in-memory tab is untouched: the file manager still needs the secrets to connect.
    expect((tab.initialSSHConfig as { password?: string }).password).toBe('pw-secret');
  });
});
