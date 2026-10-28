import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';

/** A `/`-separated path into the shared Team Vault folder tree, e.g. `"Acme Infra/Cluster A"`. */
export type TeamFolderPath = string;

export interface TeamFolderNode<T> {
  /** Just this node's own segment, e.g. `"Cluster A"` (for display). */
  name: string;
  /** The full path from the root, e.g. `"Acme Infra/Cluster A"` — the value stored in a
   * profile's `group` field, and what `teamVaultRenameFolder`/`teamVaultDeleteFolder` take. */
  path: string;
  children: TeamFolderNode<T>[];
  /** Profiles whose `group` is exactly this node's `path` (not a descendant's). */
  profiles: T[];
  /** Key into `TEAM_FOLDER_ICONS` (shared/types/teamVault.ts), or `undefined` for the default
   * folder icon — from `TeamVaultPayload.folderIcons[path]`. */
  icon?: string;
}

function splitPath(path: string): string[] {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Every folder path that should exist in the tree: the saved `folders` registry, every
 * profile's own `group`, AND every ancestor of those (so e.g. saving only
 * `"Acme Infra/Cluster A"` still synthesizes an `"Acme Infra"` node to hang it under, even if
 * that intermediate folder was never explicitly created). */
export function collectAllTeamFolderPaths(
  folders: string[],
  ssh: Array<{ group?: string }>,
  s3: Array<{ group?: string }>
): TeamFolderPath[] {
  const set = new Set<string>();
  const addWithAncestors = (path: string) => {
    const segments = splitPath(path);
    for (let i = 1; i <= segments.length; i++) {
      set.add(segments.slice(0, i).join('/'));
    }
  };
  for (const f of folders) addWithAncestors(f);
  for (const p of ssh) if (p.group) addWithAncestors(p.group);
  for (const p of s3) if (p.group) addWithAncestors(p.group);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Builds a nested folder tree (arbitrary depth, unlike personal profiles' flat `groupProfiles`)
 * out of `folders` (the shared registry — see `TeamVaultPayload.folders`) and every profile's
 * own `group` path. Profiles with no `group` are returned separately as `ungrouped`, same
 * convention as `connectionGrouping.ts`'s `UNGROUPED`.
 */
export function buildTeamFolderTree<T extends { group?: string }>(
  folders: string[],
  profiles: T[],
  folderIcons: Record<string, string> = {}
): { roots: TeamFolderNode<T>[]; ungrouped: T[] } {
  const allPaths = collectAllTeamFolderPaths(folders, profiles, []);
  const nodesByPath = new Map<string, TeamFolderNode<T>>();
  const roots: TeamFolderNode<T>[] = [];

  for (const path of allPaths) {
    const segments = splitPath(path);
    const node: TeamFolderNode<T> = {
      name: segments[segments.length - 1],
      path,
      children: [],
      profiles: [],
      icon: folderIcons[path],
    };
    nodesByPath.set(path, node);
    if (segments.length === 1) {
      roots.push(node);
    } else {
      const parentPath = segments.slice(0, -1).join('/');
      nodesByPath.get(parentPath)?.children.push(node);
    }
  }

  const sortTree = (nodes: TeamFolderNode<T>[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortTree(n.children);
  };
  sortTree(roots);

  const ungrouped: T[] = [];
  for (const p of profiles) {
    const group = p.group?.trim();
    if (!group) {
      ungrouped.push(p);
      continue;
    }
    const node = nodesByPath.get(group);
    if (node) {
      node.profiles.push(p);
    } else {
      // Shouldn't normally happen (collectAllTeamFolderPaths synthesizes every ancestor from
      // every profile's own group), but fail safe rather than silently dropping the profile.
      ungrouped.push(p);
    }
  }

  return { roots, ungrouped };
}

/** Walks `roots`/`children` down through `path`'s segments, returning the node at that exact
 * location, or `null` if any segment along the way doesn't exist. Used to resolve "which node am
 * I currently browsing" from the breadcrumb path state (`ConnectionManagerModal`'s
 * `teamFolderPath`). */
export function findFolderNode<T>(roots: TeamFolderNode<T>[], path: string[]): TeamFolderNode<T> | null {
  let level = roots;
  let node: TeamFolderNode<T> | null = null;
  for (const segment of path) {
    const next: TeamFolderNode<T> | undefined = level.find((n) => n.name === segment);
    if (!next) return null;
    node = next;
    level = next.children;
  }
  return node;
}

/** Flattens the whole tree (ignoring any notion of "current level") into every profile paired
 * with its full folder path — `null` for an ungrouped profile. Used by the folder browser's
 * search mode: `ConnectionManagerModal` already filters `ssh`/`s3` down to query matches before
 * calling `buildTeamFolderTree`, so `roots`/`ungrouped` passed in here are already the matches;
 * this just lays them out as a flat, path-labeled list instead of requiring the user to drill
 * down to find which folder(s) contained a hit. */
export function flattenTeamFolderTree<T>(
  roots: TeamFolderNode<T>[],
  ungrouped: T[]
): Array<{ profile: T; path: string | null }> {
  const result: Array<{ profile: T; path: string | null }> = [];
  const walk = (nodes: TeamFolderNode<T>[]) => {
    for (const node of nodes) {
      for (const profile of node.profiles) {
        result.push({ profile, path: node.path });
      }
      walk(node.children);
    }
  };
  walk(roots);
  for (const profile of ungrouped) {
    result.push({ profile, path: null });
  }
  return result;
}

/** Combined SSH+S3 folder paths for the "move to folder" / autocomplete affordance in the
 * profile form (folders are shared across both profile types in the Team Vault, same as the
 * personal `shareFoldersAcrossTypes` default). */
export function collectTeamFolderSuggestions(
  folders: string[],
  ssh: SSHConnectionConfig[],
  s3: S3Config[]
): TeamFolderPath[] {
  return collectAllTeamFolderPaths(folders, ssh, s3);
}
