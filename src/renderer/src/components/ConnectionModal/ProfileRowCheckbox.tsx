import React from 'react';
import type { RowSelect } from './types';

/** The checkbox at the start of a profile row. Hidden until the row is pointed at or focused, unless something is selected. */
export const ProfileRowCheckbox: React.FC<{ name: string; select: RowSelect }> = ({ name, select }) => (
  <input
    type="checkbox"
    aria-label={`Select ${name}`}
    checked={select.checked}
    onChange={select.onToggle}
    onClick={(e) => e.stopPropagation()}
    onDoubleClick={(e) => e.stopPropagation()}
    className={`h-3.5 w-3.5 shrink-0 cursor-pointer accent-sky-500 transition-opacity ${
      select.checked || select.anyChecked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
    }`}
  />
);
