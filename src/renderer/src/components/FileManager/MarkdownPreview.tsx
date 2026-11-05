import React, { useEffect, useRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HighlightedCodeBlock, PlainCodeBlock } from './MarkdownCodeBlock';
import { MarkdownLink } from './MarkdownLink';

const HIGHLIGHTED_COMPONENTS: Components = { pre: HighlightedCodeBlock, a: MarkdownLink };
const PLAIN_COMPONENTS: Components = { pre: PlainCodeBlock, a: MarkdownLink };

interface MarkdownPreviewProps {
  content: string;
  searchQuery?: string;
  currentMatchIdx?: number;
  onMatchesCountChange?: (count: number) => void;
}

const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({
  content,
  searchQuery = '',
  currentMatchIdx = 0,
  onMatchesCountChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const marksRef = useRef<HTMLElement[]>([]);

  // Highlight matches when content or searchQuery changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Remove existing marks
    const existingMarks = container.querySelectorAll('mark.md-search-hit');
    existingMarks.forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize();
      }
    });
    marksRef.current = [];

    const query = searchQuery.trim();
    if (!query) {
      onMatchesCountChange?.(0);
      return;
    }

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parentTag = node.parentElement?.tagName;
        if (parentTag === 'SCRIPT' || parentTag === 'STYLE') {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.textContent || !node.textContent.toLowerCase().includes(query.toLowerCase())) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode as Text);
    }

    const lowerQuery = query.toLowerCase();
    const createdMarks: HTMLElement[] = [];

    for (const node of textNodes) {
      const text = node.textContent || '';
      let pos: number;
      const lowerText = text.toLowerCase();
      const fragments: Node[] = [];
      let lastIdx = 0;

      while ((pos = lowerText.indexOf(lowerQuery, lastIdx)) !== -1) {
        if (pos > lastIdx) {
          fragments.push(document.createTextNode(text.slice(lastIdx, pos)));
        }
        const mark = document.createElement('mark');
        mark.className = 'md-search-hit bg-amber-400/35 text-amber-200 rounded-xs px-0.5 transition-colors';
        mark.textContent = text.slice(pos, pos + query.length);
        fragments.push(mark);
        createdMarks.push(mark);
        lastIdx = pos + query.length;
      }

      if (lastIdx < text.length) {
        fragments.push(document.createTextNode(text.slice(lastIdx)));
      }

      const parent = node.parentNode;
      if (parent && fragments.length > 0) {
        for (const frag of fragments) {
          parent.insertBefore(frag, node);
        }
        parent.removeChild(node);
      }
    }

    marksRef.current = createdMarks;
    onMatchesCountChange?.(createdMarks.length);

    // Highlight current active match and scroll to it
    if (createdMarks.length > 0) {
      const activeIdx = Math.min(Math.max(0, currentMatchIdx), createdMarks.length - 1);
      createdMarks.forEach((m, idx) => {
        if (idx === activeIdx) {
          m.className = 'md-search-hit bg-sky-500 text-white ring-2 ring-sky-300 font-semibold rounded-xs px-0.5 transition-colors';
          if (typeof m.scrollIntoView === 'function') {
            m.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
          }
        } else {
          m.className = 'md-search-hit bg-amber-400/35 text-amber-200 rounded-xs px-0.5 transition-colors';
        }
      });
    }

    return () => {
      const cleanupMarks = container.querySelectorAll('mark.md-search-hit');
      cleanupMarks.forEach((mark) => {
        const parent = mark.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
          parent.normalize();
        }
      });
      marksRef.current = [];
    };
  }, [content, searchQuery, currentMatchIdx, onMatchesCountChange]);

  // Update active match and scroll when currentMatchIdx changes
  useEffect(() => {
    const marks = marksRef.current;
    if (marks.length === 0) return;

    const activeIdx = Math.min(Math.max(0, currentMatchIdx), marks.length - 1);
    marks.forEach((m, idx) => {
      if (idx === activeIdx) {
        m.className = 'md-search-hit bg-sky-500 text-white ring-2 ring-sky-300 font-semibold rounded-xs px-0.5 transition-colors';
        if (typeof m.scrollIntoView === 'function') {
          m.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }
      } else {
        m.className = 'md-search-hit bg-amber-400/35 text-amber-200 rounded-xs px-0.5 transition-colors';
      }
    });
  }, [currentMatchIdx]);

  return (
    // The app's <body> is select-none; the preview is read like a document, so its text must be selectable.
    <div ref={containerRef} className="markdown-preview-root select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={searchQuery.trim() ? PLAIN_COMPONENTS : HIGHLIGHTED_COMPONENTS}
      >
        {content || '*Empty file*'}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownPreview;
