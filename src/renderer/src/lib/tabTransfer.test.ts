import { describe, expect, it } from 'vitest';
import type { AppTab } from './tabs';
import { registerFileManager } from './fileManagerState';
import { sanitizeTabForSession } from './tabs';
import { adoptedTab, buildTabHandoff, canMoveTab, collectTabSessions } from './tabTransfer';

const tree = {
  type: 'split' as const,
  id: 'sp',
  orientation: 'row' as const,
  children: [
    { type: 'leaf' as const, id: 'p1', local: true },
    { type: 'leaf' as const, id: 'p2', local: true },
  ],
};
const tab: AppTab = { id: 't1', type: 'terminal', title: 'T', paneTree: tree, zoomedPaneId: 'p1' };

describe('tabTransfer', () => {
  it('collects only the panes that have a running session', () => {
    const lookup = (id: string) => (id === 'p2' ? { sessionId: 's2', kind: 'ssh' as const } : undefined);
    expect(collectTabSessions(tab, lookup)).toEqual([{ paneId: 'p2', sessionId: 's2', kind: 'ssh' }]);
    expect(collectTabSessions({ id: 'f', type: 'filemanager', title: 'F' }, lookup)).toEqual([]);
  });

  it('builds a handoff without transient view state', () => {
    const handoff = buildTabHandoff(tab, () => ({ sessionId: 's', kind: 'k8s' }));
    expect(handoff.tab).not.toHaveProperty('zoomedPaneId');
    expect(handoff.tab.id).toBe('t1');
    expect(handoff.sessions.map((s) => s.paneId)).toEqual(['p1', 'p2']);
  });

  it('drops pasted editor content from the handoff', () => {
    const editor: AppTab = { id: 'e', type: 'editor', title: 'x', editorInitialContent: 'secret log content' };
    expect(buildTabHandoff(editor).tab).not.toHaveProperty('editorInitialContent');
  });

  it('refuses to move a tab with unsaved changes', () => {
    expect(canMoveTab({ ...tab, isDirty: true })).toBe(false);
    expect(canMoveTab(tab)).toBe(true);
  });

  it('adopts a received tab, always with a pane tree and never dirty', () => {
    const received = adoptedTab({ tab: { id: 't9', type: 'terminal', title: 'X', isDirty: true }, sessions: [] });
    expect(received.paneTree).toBeDefined();
    expect(received.isDirty).toBeUndefined();
  });

  describe('file manager tabs', () => {
    const snapshot = {
      left: { source: { providerId: 'local', sourceType: 'local' as const, label: 'Local Disk' }, path: '/home/a' },
      right: { source: { providerId: 'sftp-1', sourceType: 'sftp' as const, label: 'prod' }, path: '/var/www' },
      activeSide: 'right' as const,
      splitRatio: 0.4,
    };
    const fm: AppTab = {
      id: 'fm1',
      type: 'filemanager',
      title: 'Files',
      promptRemote: true,
      initialLocalPath: '/tmp',
      initialSSHConfig: { id: 'c', name: 'prod', host: 'h', port: 22, username: 'u', password: 'pw' } as never, // pragma: allowlist secret
    };

    it('carries the panes as they are and drops the way the tab was opened', () => {
      const unregister = registerFileManager('fm1', () => snapshot);
      const { tab } = buildTabHandoff(fm);
      unregister();

      expect(tab.restoredPanes).toEqual(snapshot);
      for (const key of ['promptRemote', 'initialLocalPath', 'initialSSHConfig']) expect(tab).not.toHaveProperty(key);
      expect(JSON.stringify(tab)).not.toContain('"pw"');
    });

    it('keeps the original start-up settings when the tab has not reported its panes', () => {
      const { tab } = buildTabHandoff(fm);
      expect(tab).not.toHaveProperty('restoredPanes');
      expect(tab.promptRemote).toBe(true);
    });

    it('never saves restored panes into the stored session', () => {
      expect(sanitizeTabForSession({ ...fm, restoredPanes: snapshot })).not.toHaveProperty('restoredPanes');
    });
  });
});
