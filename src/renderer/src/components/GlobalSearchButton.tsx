import React from 'react';
import { Search } from 'lucide-react';
import { getShortcutKeys } from '../lib/shortcuts';

interface GlobalSearchButtonProps {
  onOpen: () => void;
  shortcuts: Record<string, string> | undefined;
}

/**
 * The top bar's search entry: an icon button like the quick links beside it. It opens a search window
 * rather than taking text itself, so it is not drawn as a text field; the tooltip names the shortcut.
 */
export const GlobalSearchButton: React.FC<GlobalSearchButtonProps> = ({ onOpen, shortcuts }) => (
  <button
    type="button"
    data-testid="global-search-btn"
    aria-label="Search profiles, tabs and hosts"
    title={`Search profiles, tabs and hosts (${getShortcutKeys('globalSearch', shortcuts)})`}
    onClick={onOpen}
    className="flex h-6 w-6 items-center justify-center rounded-md text-txt-muted transition-colors hover:bg-app-surface-hover hover:text-txt-primary"
  >
    <Search className="h-4 w-4" aria-hidden="true" />
  </button>
);
