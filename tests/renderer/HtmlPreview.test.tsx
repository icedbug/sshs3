// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HtmlPreview } from '../../src/renderer/src/components/FileManager/HtmlPreview';

describe('HtmlPreview', () => {
  it('renders the document unmodified in a fully sandboxed iframe', () => {
    const html = '<html><body><script>alert(1)</script><a href="https://example.com">x</a></body></html>';
    render(<HtmlPreview htmlContent={html} fileName="a.html" />);
    const frame = screen.getByTitle('Preview for a.html') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(html);
  });

  it('shows a placeholder for empty content', () => {
    render(<HtmlPreview htmlContent="" fileName="e.html" />);
    expect((screen.getByTitle('Preview for e.html') as HTMLIFrameElement).getAttribute('srcdoc')).toContain('Empty HTML document');
  });
});
