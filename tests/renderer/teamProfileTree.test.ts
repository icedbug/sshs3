import { describe, it, expect } from 'vitest';
import {
  buildTeamFolderTree,
  collectAllTeamFolderPaths,
  collectTeamFolderSuggestions,
  findFolderNode,
  flattenTeamFolderTree,
} from '../../src/renderer/src/components/ConnectionModal/teamProfileTreeModel';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

const ssh = (id: string, group?: string): SSHConnectionConfig =>
  ({ id, name: id, host: `${id}.example.com`, username: 'root', authType: 'password', group }) as SSHConnectionConfig;

describe('teamProfileTree', () => {
  describe('collectAllTeamFolderPaths', () => {
    it('synthesizes every ancestor of a deep folder, even if only the leaf was ever saved', () => {
      const paths = collectAllTeamFolderPaths(['Acme Infra/Cluster A/Node 1'], [], []);
      expect(paths).toEqual(['Acme Infra', 'Acme Infra/Cluster A', 'Acme Infra/Cluster A/Node 1']);
    });

    it('also synthesizes ancestors from a profile group path that was never explicitly saved as a folder', () => {
      const paths = collectAllTeamFolderPaths([], [ssh('p1', 'Acme Infra/Cluster A')], []);
      expect(paths).toEqual(['Acme Infra', 'Acme Infra/Cluster A']);
    });

    it('deduplicates and sorts', () => {
      const paths = collectAllTeamFolderPaths(['B', 'A', 'A'], [ssh('p1', 'A')], []);
      expect(paths).toEqual(['A', 'B']);
    });
  });

  describe('buildTeamFolderTree', () => {
    it('builds a nested tree and places profiles at their exact group node', () => {
      const profiles = [ssh('p1', 'Acme Infra'), ssh('p2', 'Acme Infra/Cluster A'), ssh('p3')];
      const { roots, ungrouped } = buildTeamFolderTree(['Acme Infra', 'Acme Infra/Cluster A'], profiles);

      expect(roots).toHaveLength(1);
      const acme = roots[0];
      expect(acme.name).toBe('Acme Infra');
      expect(acme.path).toBe('Acme Infra');
      expect(acme.profiles.map((p) => p.id)).toEqual(['p1']);
      expect(acme.children).toHaveLength(1);
      expect(acme.children[0].path).toBe('Acme Infra/Cluster A');
      expect(acme.children[0].profiles.map((p) => p.id)).toEqual(['p2']);

      expect(ungrouped.map((p) => p.id)).toEqual(['p3']);
    });

    it('builds an empty folder node from the registry alone, with no profiles in it', () => {
      const { roots } = buildTeamFolderTree(['Empty Folder'], []);
      expect(roots).toHaveLength(1);
      expect(roots[0].profiles).toEqual([]);
    });

    it('sorts siblings alphabetically at every depth', () => {
      const { roots } = buildTeamFolderTree(['B', 'A', 'A/Z', 'A/Y'], []);
      expect(roots.map((n) => n.name)).toEqual(['A', 'B']);
      expect(roots[0].children.map((n) => n.name)).toEqual(['Y', 'Z']);
    });

    it('three levels deep: a jumpbox and two clusters under one system', () => {
      const profiles = [
        ssh('jump', 'Acme Infra/Jumpbox'),
        ssh('n1', 'Acme Infra/Cluster A/Nodes'),
        ssh('n2', 'Acme Infra/Cluster B/Nodes'),
      ];
      const { roots } = buildTeamFolderTree([], profiles);
      expect(roots).toHaveLength(1);
      const system = roots[0];
      expect(system.path).toBe('Acme Infra');
      expect(system.children.map((c) => c.name)).toEqual(['Cluster A', 'Cluster B', 'Jumpbox']);
      const clusterA = system.children.find((c) => c.name === 'Cluster A')!;
      expect(clusterA.children[0].path).toBe('Acme Infra/Cluster A/Nodes');
      expect(clusterA.children[0].profiles.map((p) => p.id)).toEqual(['n1']);
    });
  });

  describe('collectTeamFolderSuggestions', () => {
    it('combines folders and both profile types group paths', () => {
      const suggestions = collectTeamFolderSuggestions(['A'], [ssh('p1', 'B')], [{ id: 's1', name: 's1', group: 'C' } as any]);
      expect(suggestions).toEqual(['A', 'B', 'C']);
    });
  });

  describe('findFolderNode', () => {
    it('resolves a node at any depth by walking the path segments', () => {
      const { roots } = buildTeamFolderTree(['Acme Infra/Cluster A/Nodes'], []);
      const node = findFolderNode(roots, ['Acme Infra', 'Cluster A', 'Nodes']);
      expect(node?.path).toBe('Acme Infra/Cluster A/Nodes');
    });

    it('returns the root node itself for a one-segment path', () => {
      const { roots } = buildTeamFolderTree(['Acme Infra'], []);
      expect(findFolderNode(roots, ['Acme Infra'])?.path).toBe('Acme Infra');
    });

    it('returns null for a path that does not exist', () => {
      const { roots } = buildTeamFolderTree(['Acme Infra'], []);
      expect(findFolderNode(roots, ['Acme Infra', 'Ghost'])).toBeNull();
      expect(findFolderNode(roots, ['Nonexistent'])).toBeNull();
    });
  });

  describe('flattenTeamFolderTree', () => {
    it('lists every profile in the tree with its full folder path', () => {
      const profiles = [ssh('p1', 'Acme Infra'), ssh('p2', 'Acme Infra/Cluster A')];
      const { roots, ungrouped } = buildTeamFolderTree(['Acme Infra', 'Acme Infra/Cluster A'], profiles);

      const flat = flattenTeamFolderTree(roots, ungrouped);
      expect(flat).toEqual(
        expect.arrayContaining([
          { profile: expect.objectContaining({ id: 'p1' }), path: 'Acme Infra' },
          { profile: expect.objectContaining({ id: 'p2' }), path: 'Acme Infra/Cluster A' },
        ])
      );
      expect(flat).toHaveLength(2);
    });

    it('gives an ungrouped profile a null path', () => {
      const profiles = [ssh('p1')];
      const { roots, ungrouped } = buildTeamFolderTree([], profiles);

      expect(flattenTeamFolderTree(roots, ungrouped)).toEqual([{ profile: expect.objectContaining({ id: 'p1' }), path: null }]);
    });
  });
});
