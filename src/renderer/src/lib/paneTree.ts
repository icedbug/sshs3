import type { PaneLeaf, PaneNode, PaneOrientation, PaneSplit } from '@shared/types/session';

let paneCounter = 0;

export function genPaneId(prefix: string): string {
  paneCounter += 1;
  return `${prefix}-p${Date.now().toString(36)}${paneCounter}`;
}

export function createLeaf(id: string, over?: Partial<Omit<PaneLeaf, 'type' | 'id'>>): PaneLeaf {
  return { type: 'leaf', id, ...over };
}

export function countLeaves(node: PaneNode): number {
  return node.type === 'leaf' ? 1 : node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findLeaf(child, id);
    if (found) return found;
  }
  return null;
}

/** Panes other than `exceptId` that hold a live or connectable session (not an empty placeholder). */
export function countOtherSessionPanes(node: PaneNode, exceptId: string): number {
  return collectLeaves(node).filter(
    (leaf) => leaf.id !== exceptId && Boolean(leaf.config || leaf.local || leaf.k8sTarget || leaf.k8sLogTarget)
  ).length;
}

/** True for a plain local-shell pane (the same precedence PaneLeafContent uses to pick the view). */
export function isLocalShellLeaf(leaf: PaneLeaf): boolean {
  return Boolean(leaf.local && !leaf.config && !leaf.k8sTarget && !leaf.k8sLogTarget);
}

/**
 * Two or more local shells in one tab would each sample and draw the same machine's metrics, so the tab shows
 * a single shared bar instead. A lone local pane keeps its own bar.
 */
export function shouldHoistLocalPerf(node: PaneNode): boolean {
  return collectLeaves(node).filter(isLocalShellLeaf).length >= 2;
}

export function getFirstLeafId(node: PaneNode): string {
  return node.type === 'leaf' ? node.id : getFirstLeafId(node.children[0]);
}

/** Returns every leaf's id, in the tree's depth-first (left-to-right) order — the order panes are laid out on screen. */
export function collectLeafIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return node.children.flatMap((c) => collectLeafIds(c));
}

/** Returns every leaf in the tree, in depth-first (left-to-right) order. */
export function collectLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node];
  return node.children.flatMap((c) => collectLeaves(c));
}

/** Returns a new tree with the leaf matching `id` replaced via `updater`; other leaves keep their identity. */
export function updateLeaf(node: PaneNode, id: string, updater: (leaf: PaneLeaf) => PaneLeaf): PaneNode {
  if (node.type === 'leaf') {
    return node.id === id ? updater(node) : node;
  }
  let changed = false;
  const children = node.children.map((c) => {
    const next = updateLeaf(c, id, updater);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** Returns a new tree with the split node `splitId`'s `weights` set (§23) — other nodes keep
 * their identity, same convention as `updateLeaf`. No-op (returns the same tree) if `splitId`
 * isn't found or isn't a split. */
export function updateSplitWeights(node: PaneNode, splitId: string, weights: number[]): PaneNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) return { ...node, weights };
  let changed = false;
  const children = node.children.map((c) => {
    const next = updateSplitWeights(c, splitId, weights);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/**
 * Splits the pane `paneId` in the given orientation, mirroring Konsole's ViewSplitter::addTerminalWidget:
 * when the pane's parent split already has the same orientation the new leaf is inserted as a sibling
 * (no extra nesting); otherwise the existing leaf is wrapped in place inside a new split node together
 * with the new leaf. The existing leaf keeps its id, so its live TerminalView/session is never recreated.
 */
export function splitPane(
  tree: PaneNode,
  paneId: string,
  orientation: PaneOrientation,
  idPrefix: string
): { tree: PaneNode; newPaneId: string } {
  const newLeaf = createLeaf(genPaneId(idPrefix));

  function recurse(node: PaneNode): PaneNode {
    if (node.type === 'leaf') {
      if (node.id !== paneId) return node;
      return {
        type: 'split',
        id: genPaneId(`${idPrefix}-split`),
        orientation,
        children: [node, newLeaf],
      };
    }

    const targetIndex = node.children.findIndex((c) => c.type === 'leaf' && c.id === paneId);
    if (targetIndex !== -1) {
      if (node.orientation === orientation) {
        const children = [...node.children];
        children.splice(targetIndex + 1, 0, newLeaf);
        return { ...node, children };
      }
      const wrapped: PaneSplit = {
        type: 'split',
        id: genPaneId(`${idPrefix}-split`),
        orientation,
        children: [node.children[targetIndex], newLeaf],
      };
      const children = [...node.children];
      children[targetIndex] = wrapped;
      return { ...node, children };
    }

    let changed = false;
    const children = node.children.map((c) => {
      const next = recurse(c);
      if (next !== c) changed = true;
      return next;
    });
    return changed ? { ...node, children } : node;
  }

  return { tree: recurse(tree), newPaneId: newLeaf.id };
}

/**
 * Removes the pane `paneId` from the tree, mirroring Konsole's collapse-on-childEvent behavior: a split
 * left with a single child is replaced by that child directly, so no dead single-child splits accumulate.
 * Returns null if `paneId` is the tree's only leaf (the caller should close the whole tab instead).
 */
export function closePane(tree: PaneNode, paneId: string): PaneNode | null {
  if (tree.type === 'leaf') {
    return tree.id === paneId ? null : tree;
  }

  function recurse(node: PaneSplit): PaneNode {
    const children: PaneNode[] = [];
    for (const child of node.children) {
      if (child.type === 'leaf' && child.id === paneId) continue;
      children.push(child.type === 'split' ? recurse(child) : child);
    }
    return children.length === 1 ? children[0] : { ...node, children };
  }

  return recurse(tree);
}
