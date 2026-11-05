// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CodeEditor } from '../../src/renderer/src/components/Editor/CodeEditor';

describe('CodeEditor', () => {
  beforeEach(() => {
    Range.prototype.getClientRects = () => [] as any;
    Range.prototype.getBoundingClientRect = () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }) as any;
  });

  it('renders without crashing and initializes with value', () => {
    const { container } = render(
      <CodeEditor
        value="const x = 42;"
        fileName="test.ts"
        onChange={vi.fn()}
      />
    );

    const editorEl = screen.getByTestId('code-editor');
    expect(editorEl).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    // CodeMirror injects .cm-editor inside the container
    expect(container.querySelector('.cm-editor')).toBeInTheDocument();
    expect(container.textContent).toContain('const x = 42;');
  });

  it('handles readOnly mode and fileName changes without crashing', () => {
    const { rerender, container } = render(
      <CodeEditor
        value="initial text"
        fileName="notes.txt"
        readOnly={true}
      />
    );

    expect(container.querySelector('.cm-editor')).toBeInTheDocument();

    rerender(
      <CodeEditor
        value="updated text"
        fileName="notes.md"
        readOnly={false}
      />
    );

    expect(container.textContent).toContain('updated text');
  });

  it('calls onChange when document changes via view dispatch', () => {
    const onChange = vi.fn();
    let editorHandle: any = null;
    render(
      <CodeEditor
        ref={(handle) => {
          editorHandle = handle;
        }}
        value="first"
        fileName="test.txt"
        onChange={onChange}
      />
    );

    expect(editorHandle).not.toBeNull();
    const view = editorHandle?.getView();
    expect(view).not.toBeNull();
    view?.dispatch({
      changes: { from: 0, to: 5, insert: 'second' },
    });

    expect(onChange).toHaveBeenCalledWith('second');
  });

  it('reports case-insensitive match count using SearchQuery cursor', () => {
    const onMatchesCountChange = vi.fn();
    render(
      <CodeEditor
        value="Alpha beta ALPHA gamma Alpha"
        fileName="test.txt"
        searchQuery="alpha"
        onMatchesCountChange={onMatchesCountChange}
      />
    );

    expect(onMatchesCountChange).toHaveBeenCalledWith(3);
  });
});

