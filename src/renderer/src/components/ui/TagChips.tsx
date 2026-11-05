import React from 'react';

export interface TagChipsProps {
  tags?: string[];
  /** Chips shown before the rest collapse into "+N" (the full list stays in the title tooltip). */
  max?: number;
}

/** Read-only tag chips for profile rows; renders nothing when there are no tags. */
export const TagChips: React.FC<TagChipsProps> = ({ tags, max = 3 }) => {
  if (!tags || tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const hidden = tags.length - shown.length;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={tags.join(', ')} data-testid="tag-chips">
      {shown.map((tag) => (
        <span
          key={tag}
          className="rounded border border-border-subtle bg-app-surface px-1.5 py-px text-2xs text-txt-secondary"
        >
          {tag}
        </span>
      ))}
      {hidden > 0 && <span className="text-2xs text-txt-muted">+{hidden}</span>}
    </span>
  );
};
