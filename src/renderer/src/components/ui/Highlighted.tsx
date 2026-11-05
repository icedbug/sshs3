import React from 'react';
import { splitHighlight } from '../../lib/globalSearchRows';

/** `text` with the characters at `indices` (a fuzzy match) emphasised. */
export const Highlighted: React.FC<{ text: string; indices: number[] }> = ({ text, indices }) => (
  <>
    {splitHighlight(text, indices).map((piece, i) =>
      piece.hit ? (
        <mark key={i} className="bg-transparent font-semibold text-sky-400">
          {piece.text}
        </mark>
      ) : (
        <React.Fragment key={i}>{piece.text}</React.Fragment>
      )
    )}
  </>
);
