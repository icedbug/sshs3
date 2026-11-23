import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRendererLogger } from '../lib/log';

const log = createRendererLogger('render');

/**
 * Whether the error is a part of the app that could not be downloaded. After an update a page that was
 * already open asks for files that are gone, and the only way on is to load the page again.
 */
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return /dynamically imported module|Importing a module script failed|ChunkLoadError|Loading (CSS )?chunk|Unable to preload CSS/i.test(
    text
  );
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** What failed, as the message names it: "The assistant", "This view". */
  what: string;
  /**
   * "fill": a box in the middle of the part's own room. "notice": a small box in a corner, for a part
   * that has no room of its own (a side panel, a dialog). "window": the whole window failed.
   */
  layout?: 'fill' | 'notice' | 'window';
  /** When this changes the part is drawn again: another view or another conversation was chosen. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  failed: boolean;
  error: unknown;
  resetKey: unknown;
}

/**
 * Keeps one part that fails to draw from blanking the window. The part is replaced by a plain message
 * with a way on, and everything outside it keeps working.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, error: undefined, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { failed: true, error };
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { failed: false, error: undefined, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    log.error(`${this.props.what} could not be drawn`, {
      message: error instanceof Error ? error.message : String(error),
      stack: info.componentStack ?? undefined,
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const { what, layout = 'fill' } = this.props;
    const missingFiles = isChunkLoadError(this.state.error);
    const place =
      layout === 'notice'
        ? 'fixed bottom-4 left-4 z-[200] max-w-sm'
        : layout === 'window'
          ? 'flex h-screen w-screen items-center justify-center bg-app p-6'
          : 'flex h-full min-h-0 w-full flex-1 items-center justify-center p-6';
    return (
      <div role="alert" data-testid="error-boundary" className={place}>
        <div className="max-w-md rounded-xl border border-border-subtle bg-app-card p-4 text-sm text-txt-primary shadow-lg">
          <p className="font-semibold">{what} could not be shown.</p>
          <p className="mt-1 text-xs leading-relaxed text-txt-secondary">
            {missingFiles
              ? 'A newer version of sshs3 was probably installed while this page was open. Reload to get it.'
              : layout === 'window'
                ? 'Something went wrong. Reload to start again.'
                : 'Something went wrong in this part. The rest of the app still works.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!missingFiles && layout !== 'window' && (
              <button
                type="button"
                onClick={() => this.setState({ failed: false, error: undefined })}
                className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary transition-colors hover:bg-app-surface-hover hover:text-txt-primary"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-sky-500"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
