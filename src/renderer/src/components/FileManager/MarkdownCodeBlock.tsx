import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { codeToCopy, highlightCode, readCodeBlock } from '../../lib/markdownCodeHighlight';

const COPIED_RESET_MS = 1500;

/**
 * A fenced code block of the markdown preview: syntax colours (unless `highlight` is off) and a
 * copy button. The button only shows on hover or keyboard focus, like on GitHub.
 */
function CodeBlockFrame({ children, highlight }: { children?: ReactNode; highlight: boolean }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const block = readCodeBlock(children);
  const text = block ? codeToCopy(block.code) : '';
  const lang = block?.lang;
  // Depend on the strings, not on `block`: that object is new on every render, which would parse the
  // whole block again each time the copy button changes state.
  const segments = useMemo(
    () => (highlight && text ? highlightCode(text, lang) : null),
    [highlight, text, lang]
  );

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  if (!block) return <pre>{children}</pre>;

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
      },
      () => {
        // Clipboard access refused: nothing to confirm.
      }
    );
  };

  return (
    <div className="group/code relative">
      <pre>
        <code className={block.lang ? `language-${block.lang}` : undefined}>
          {segments
            ? segments.map((s, i) =>
                s.className ? (
                  <span key={i} className={s.className}>
                    {s.text}
                  </span>
                ) : (
                  s.text
                )
              )
            : text}
        </code>
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
        className="absolute right-2 top-2 rounded-md border border-border-subtle bg-app-surface p-1.5 text-txt-muted opacity-0 transition-opacity hover:text-txt-primary focus-visible:opacity-100 group-hover/code:opacity-100 group-focus-within/code:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/**
 * Two component types rather than one with a prop: while a search is active the preview switches to
 * plain code, because the search splits text nodes and a phrase running across coloured tokens would
 * not be found. Different types make React replace the block instead of patching text nodes that the
 * search has already replaced.
 */
export const HighlightedCodeBlock: React.FC<{ children?: ReactNode }> = ({ children }) => (
  <CodeBlockFrame highlight>{children}</CodeBlockFrame>
);

export const PlainCodeBlock: React.FC<{ children?: ReactNode }> = ({ children }) => (
  <CodeBlockFrame highlight={false}>{children}</CodeBlockFrame>
);
