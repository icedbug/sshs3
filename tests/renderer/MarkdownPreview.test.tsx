// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import MarkdownPreview from '../../src/renderer/src/components/FileManager/MarkdownPreview';
import { highlightCode } from '../../src/renderer/src/lib/markdownCodeHighlight';

vi.mock('../../src/renderer/src/lib/markdownCodeHighlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/lib/markdownCodeHighlight')>();
  return { ...actual, highlightCode: vi.fn(actual.highlightCode) };
});

const DOC = [
  '# Title',
  '',
  'Some `inline` text.',
  '',
  '```bash',
  'ssh user@host -p 22',
  'echo "hej"',
  '```',
  '',
  '- [x] done',
  '- [ ] todo',
].join('\n');

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { multissh?: unknown }).multissh;
});

describe('MarkdownPreview', () => {
  it('makes its text selectable although the app body is select-none', () => {
    const { container } = render(<MarkdownPreview content={DOC} />);
    expect(container.querySelector('.markdown-preview-root')).toHaveClass('select-text');
  });

  it('renders headings, a fenced code block with its text intact and task list checkboxes', () => {
    const { container } = render(<MarkdownPreview content={DOC} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    const code = container.querySelector('pre code') as HTMLElement;
    expect(code).toHaveClass('language-bash');
    expect(code.textContent).toBe('ssh user@host -p 22\necho "hej"');
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it('colours the code of a known language', () => {
    const { container } = render(<MarkdownPreview content={DOC} />);
    expect(container.querySelector('pre code [class*="tok-"]')).not.toBeNull();
  });

  it('leaves code of an unknown language as plain text', () => {
    const { container } = render(<MarkdownPreview content={'```\nplain text\n```'} />);
    const code = container.querySelector('pre code') as HTMLElement;
    expect(code.textContent).toBe('plain text');
    expect(code.querySelector('span')).toBeNull();
  });

  it('copies exactly the code, without the fence and the final newline', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MarkdownPreview content={DOC} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    expect(writeText).toHaveBeenCalledWith('ssh user@host -p 22\necho "hej"');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());
  });

  it('does not parse the code again when the copy button changes state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MarkdownPreview content={DOC} />);
    const parsedOnRender = vi.mocked(highlightCode).mock.calls.length;
    expect(parsedOnRender).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument());

    expect(vi.mocked(highlightCode).mock.calls.length).toBe(parsedOnRender);
  });

  it('does not break when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MarkdownPreview content={DOC} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
  });

  describe('search', () => {
    it('finds a phrase that runs across several syntax tokens of a code block', () => {
      const onCount = vi.fn();
      render(<MarkdownPreview content={DOC} searchQuery="ssh user@host" onMatchesCountChange={onCount} />);
      expect(onCount).toHaveBeenLastCalledWith(1);
    });

    it('goes back to coloured code when the search is cleared, without errors', () => {
      const onCount = vi.fn();
      const { container, rerender } = render(
        <MarkdownPreview content={DOC} searchQuery="echo" onMatchesCountChange={onCount} />
      );
      expect(onCount).toHaveBeenLastCalledWith(1);
      expect(container.querySelector('pre code [class*="tok-"]')).toBeNull();

      rerender(<MarkdownPreview content={DOC} searchQuery="" onMatchesCountChange={onCount} />);
      expect(container.querySelector('pre code [class*="tok-"]')).not.toBeNull();
      expect(container.querySelector('mark.md-search-hit')).toBeNull();
      expect((container.querySelector('pre code') as HTMLElement).textContent).toBe('ssh user@host -p 22\necho "hej"');
    });
  });

  describe('links', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const withApi = () => {
      openExternal.mockClear();
      (window as unknown as { multissh: unknown }).multissh = { openExternal };
    };

    it('opens a web link in the system browser instead of navigating the window', () => {
      withApi();
      render(<MarkdownPreview content="See [the docs](https://example.com/docs) now." />);
      const link = screen.getByRole('link', { name: 'the docs' });

      const notPrevented = fireEvent.click(link);

      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(openExternal).toHaveBeenCalledWith('https://example.com/docs');
      expect(notPrevented).toBe(false); // preventDefault was called
    });

    it('shows where a link really goes, whatever its text says', () => {
      withApi();
      render(<MarkdownPreview content="[https://github.com](https://evil.example/login)" />);
      expect(screen.getByRole('link')).toHaveAttribute('title', 'https://evil.example/login');
    });

    it('does not turn relative links, anchors, mailto and script links into clickable links', () => {
      withApi();
      render(
        <MarkdownPreview
          content={[
            '[rel](./other.md)',
            '[anchor](#section)',
            '[mail](mailto:a@example.com)',
            '[script](javascript:alert(1))',
            '[file](file:///etc/passwd)',
            '[creds](https://github.com@evil.example/)',
          ].join('\n\n')}
        />
      );
      expect(screen.queryByRole('link')).toBeNull();
      for (const text of ['rel', 'anchor', 'mail', 'script', 'file', 'creds']) {
        expect(screen.getByText(text)).toBeInTheDocument();
      }
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('keeps the title the author gave a link and adds where it goes', () => {
      withApi();
      render(<MarkdownPreview content={'[docs](https://example.com/d "Open the docs")'} />);
      expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
        'title',
        'Open the docs (https://example.com/d)'
      );
    });

    it('attaches a handler to a failed open, so it cannot become an unhandled rejection', () => {
      const failed = Promise.reject(new Error('no handler for this scheme'));
      failed.catch(() => {}); // keeps this test itself clean
      const then = vi.spyOn(failed, 'then');
      // A plain function: vi.fn() would attach a handler of its own to the promise it returns.
      (window as unknown as { multissh: unknown }).multissh = { openExternal: () => failed };
      render(<MarkdownPreview content="[x](https://example.com)" />);

      fireEvent.click(screen.getByRole('link', { name: 'x' }));

      expect(then).toHaveBeenCalled();
    });

    it('does nothing, and does not throw, when the app API is missing', () => {
      render(<MarkdownPreview content="[x](https://example.com)" />);
      expect(() => fireEvent.click(screen.getByRole('link', { name: 'x' }))).not.toThrow();
    });
  });
});
