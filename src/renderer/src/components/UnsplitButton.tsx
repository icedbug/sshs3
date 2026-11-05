import React from 'react';
import { SquareX } from 'lucide-react';
import { useConfirm } from './ConfirmDialog';
import { countLeaves, countOtherSessionPanes, getFirstLeafId } from '../lib/paneTree';
import type { PaneNode } from '@shared/types/session';

interface UnsplitButtonProps {
  tabId: string;
  paneTree: PaneNode;
  activePaneId?: string;
  onUnsplit: (tabId: string) => void;
}

/** Closes every pane but the active one; asks first when that would end other sessions. */
export const UnsplitButton: React.FC<UnsplitButtonProps> = ({ tabId, paneTree, activePaneId, onUnsplit }) => {
  const confirm = useConfirm();

  const handleClick = async (): Promise<void> => {
    const keepId = activePaneId ?? getFirstLeafId(paneTree);
    const sessions = countOtherSessionPanes(paneTree, keepId);
    if (sessions > 0) {
      const others = countLeaves(paneTree) - 1;
      const ok = await confirm({
        title: 'Close other panes',
        message: `Close ${others} other ${others === 1 ? 'pane' : 'panes'} and end ${sessions} ${
          sessions === 1 ? 'session' : 'sessions'
        }? Only the active pane is kept.`,
        confirmLabel: 'Close panes',
      });
      if (!ok) return;
    }
    onUnsplit(tabId);
  };

  return (
    <button
      type="button"
      title="Close other panes (keeps only the active one)"
      data-testid={`unsplit-${tabId}`}
      onClick={() => void handleClick()}
      className="flex items-center gap-1 rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
    >
      <SquareX className="h-3.5 w-3.5" />
      <span>Close others</span>
    </button>
  );
};
