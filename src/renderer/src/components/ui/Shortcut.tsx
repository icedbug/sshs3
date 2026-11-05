import React from 'react';
import { Kbd, type KbdProps } from './Kbd';
import { getShortcutKeys } from '../../lib/shortcuts';

export interface ShortcutProps extends Omit<KbdProps, 'children'> {
  /** A `SHORTCUT_DEFINITIONS` id, e.g. 'openProfiles'. */
  id: string;
  /** Current bindings (`settings.shortcuts`); falls back to the id's default when absent. */
  shortcuts: Record<string, string> | undefined;
}

/** Renders a shortcut's live key combo so labels stay correct when the user rebinds it. */
export const Shortcut: React.FC<ShortcutProps> = ({ id, shortcuts, ...kbdProps }) => (
  <Kbd {...kbdProps}>{getShortcutKeys(id, shortcuts)}</Kbd>
);

export default Shortcut;
