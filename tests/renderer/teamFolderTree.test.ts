import { describe, it, expect } from 'vitest';
import {
  buildTeamFolderTree,
  collectAllTeamFolderPaths,
  collectTeamFolderSuggestions,
  countTeamFolderProfiles,
  filterTeamFolderNamesForTab,
  findFolderNode,
  flattenTeamFolderTree,
  folderAncestors,
} from '../../src/renderer/src/components/ConnectionModal/teamFolderTree';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { S3Config } from '../../src/shared/types/storage';

const ssh = (id: string, group?: string): SSHConnectionConfig =>
  ({ id, name: id, host: `${id}.example.com`, username: 'root', authType: 'password', group }) as SSHConnectionConfig;

const s3 = (id: string, group?: string): S3Config => ({ id, name: id, group }) as S3Config;

describe('teamFolderTree', () => {
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

  describe('filterTeamFolderNamesForTab', () => {
    it('hides a folder used only by the other profile type', () => {
      const folders = ['Infra', 'Cluster B'];
      const sshProfiles = [ssh('p1', 'Infra')];
      const s3Profiles = [s3('p2', 'Cluster B')];

      expect(filterTeamFolderNamesForTab('ssh', folders, sshProfiles, s3Profiles)).toEqual(['Infra']);
      expect(filterTeamFolderNamesForTab('s3', folders, sshProfiles, s3Profiles)).toEqual(['Cluster B']);
    });

    it('keeps an ancestor folder visible when only a descendant holds a matching profile', () => {
      const folders = ['Infra', 'Infra/Cluster A'];
      const sshProfiles = [ssh('p1', 'Infra/Cluster A')];
      const s3Profiles: S3Config[] = [];

      expect(filterTeamFolderNamesForTab('ssh', folders, sshProfiles, s3Profiles)).toEqual(['Infra', 'Infra/Cluster A']);
      expect(filterTeamFolderNamesForTab('s3', folders, sshProfiles, s3Profiles)).toEqual([]);
    });

    it('keeps a brand-new folder with no profiles of either type on both tabs', () => {
      const folders = ['New Folder'];
      expect(filterTeamFolderNamesForTab('ssh', folders, [], [])).toEqual(['New Folder']);
      expect(filterTeamFolderNamesForTab('s3', folders, [], [])).toEqual(['New Folder']);
    });
  });
});

describe('countTeamFolderProfiles', () => {
  it('counts the profiles in a folder and in every folder below it', () => {
    const { roots } = buildTeamFolderTree(
      ['Acme', 'Acme/Prod', 'Acme/Prod/Web'],
      [
        { group: 'Acme' },
        { group: 'Acme/Prod' },
        { group: 'Acme/Prod' },
        { group: 'Acme/Prod/Web' },
        { group: 'Other' },
      ],
      {}
    );
    const acme = roots.find((n) => n.name === 'Acme')!;
    expect(countTeamFolderProfiles(acme)).toBe(4);
    expect(countTeamFolderProfiles(acme.children[0])).toBe(3);
    expect(countTeamFolderProfiles(acme.children[0].children[0])).toBe(1);
  });

  it('is zero for an empty folder', () => {
    const { roots } = buildTeamFolderTree(['Empty'], [], {});
    expect(countTeamFolderProfiles(roots[0])).toBe(0);
  });
});

describe('folderAncestors', () => {
  it('lists the paths of every folder above the given one, outermost first', () => {
    expect(folderAncestors(['Acme', 'Prod', 'Web'])).toEqual(['Acme', 'Acme/Prod']);
  });

  it('is empty for a top-level folder and for the root', () => {
    expect(folderAncestors(['Acme'])).toEqual([]);
    expect(folderAncestors([])).toEqual([]);
  });
});
