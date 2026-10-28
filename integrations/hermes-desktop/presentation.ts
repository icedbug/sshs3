import { atom } from 'nanostores';
import { findGroupOfPane, type LayoutNode } from '@/components/pane-shell/tree/model';
import type { NativeToolState } from '@/sshs3-shared/nativeHermes';

export const $sshs3Compact = atom(false);
export const $sshs3Tools = atom<NativeToolState>({ bindings: [] });
export function sshs3PresentationTree(tree: LayoutNode | null, compact: boolean): LayoutNode | null {
  // Geometry only: original stores, contribution hosts and session identities remain authoritative.
  if (!compact || !tree) return tree;
  const chat = findGroupOfPane(tree, 'workspace');
  return chat ? { ...chat, tabStrip: 'never' } : tree;
}
