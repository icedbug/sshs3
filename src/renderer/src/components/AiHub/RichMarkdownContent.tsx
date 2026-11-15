import { Component, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, FileCode2, Play, Terminal } from "lucide-react";
import { AnsiLogView, DiffViewer, HighlightedCode } from "./DiffViewer";
import { decodeFileRefHref, linkReportRefs, type FileRef } from "./reportRefs";

class DiffErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "powershell", "cmd", "ontap-cli"]);
const ANSI_LANGS = new Set(["ansi", "terminal", "console", "tty"]);
const ESC_CSI = `${String.fromCharCode(27)}[`;

/** Copies text to the system clipboard, returning true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ai-mini-btn"
      onClick={() => {
        void copyToClipboard(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function isLikelyDiff(lang: string, raw: string): boolean {
  if (lang === "diff" || lang === "patch") return true;
  const lines = raw.split("\n");
  const hasUnifiedHeaders =
    lines.some((line) => line.startsWith("--- ")) && lines.some((line) => line.startsWith("+++ "));
  const hasHunk = lines.some((line) => line.startsWith("@@ "));
  return hasUnifiedHeaders || hasHunk;
}

function isLikelyAnsi(lang: string, raw: string): boolean {
  if (ANSI_LANGS.has(lang)) return true;
  return raw.includes(ESC_CSI);
}

export interface RichMarkdownContentProps {
  text: string;
  /** Stages a shell command into the active terminal composer / prompt. */
  onUseCommand?: (cmd: string) => void;
  /** Runs a shell command directly in the active terminal session. */
  onRunCommand?: (cmd: string) => void;
  /** The short names of this conversation's commands; `[cN]` becomes a clickable ref link. */
  refs?: ReadonlySet<string>;
  onOpenRef?: (ref: string) => void;
  /** Invoked when the user clicks a parsed `host:/path:line` or `/path:line` citation. */
  onOpenFileRef?: (fileRef: FileRef) => void;
}

/**
 * Renders markdown prose from AI responses with syntax-highlighted code fences,
 * inline unified diffs (`DiffViewer`), ANSI logs (`AnsiLogView`), shell command
 * handoff buttons, and clickable `[cN]` / file-line citations.
 */
export function RichMarkdownContent({
  text,
  onUseCommand,
  onRunCommand,
  refs,
  onOpenRef,
  onOpenFileRef,
}: RichMarkdownContentProps) {
  const linked = linkReportRefs(text, refs);

  return (
    <div className="ai-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }: { href?: string; children?: ReactNode }) {
            const ref = /^#ref-(c\d+)$/.exec(href ?? "")?.[1];
            if (ref) {
              return (
                <button
                  type="button"
                  className="ai-ref"
                  title={`Show command ${ref}`}
                  onClick={() => onOpenRef?.(ref)}
                >
                  {children}
                </button>
              );
            }
            const fileRef = decodeFileRefHref(href);
            if (fileRef) {
              const titleParts = [
                fileRef.host ? `${fileRef.host}:` : "",
                fileRef.path,
                fileRef.line ? `:${fileRef.line}` : "",
              ].join("");
              return (
                <button
                  type="button"
                  className="ai-ref ai-file-ref"
                  data-testid="ai-file-ref-btn"
                  title={`Open ${titleParts}`}
                  onClick={() => {
                    if (onOpenFileRef) {
                      onOpenFileRef(fileRef);
                    } else {
                      window.dispatchEvent(new CustomEvent("sshs3:open-file-ref", { detail: fileRef }));
                    }
                  }}
                >
                  <FileCode2 size={11} />
                  <span>{children}</span>
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children, ...props }) {
            const raw = String(children ?? "").replace(/\n$/, "");
            const langMatch = /language-([^\s]+)/.exec(className ?? "");
            const isBlock = Boolean(langMatch) || raw.includes("\n");
            if (!isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }

            const lang = (langMatch?.[1] || "shell").toLowerCase();
            if (isLikelyDiff(lang, raw)) {
              return (
                <div className="ai-code-block" data-testid="ai-markdown-diff">
                  <div className="ai-code-head">
                    <span>diff</span>
                    <div className="ai-code-actions">
                      <CopyButton text={raw} />
                    </div>
                  </div>
                  <DiffErrorBoundary
                    fallback={
                      <pre className="ai-code-pre">
                        <HighlightedCode code={raw} lang="diff" />
                      </pre>
                    }
                  >
                    <DiffViewer diff={raw} />
                  </DiffErrorBoundary>
                </div>
              );
            }

            if (isLikelyAnsi(lang, raw)) {
              return (
                <div className="ai-code-block" data-testid="ai-markdown-ansi">
                  <div className="ai-code-head">
                    <span>{lang || "output"}</span>
                    <div className="ai-code-actions">
                      <CopyButton text={raw} />
                    </div>
                  </div>
                  <AnsiLogView text={raw} />
                </div>
              );
            }

            const isShell = SHELL_LANGS.has(lang);
            return (
              <div className="ai-code-block">
                <div className="ai-code-head">
                  <span>{lang}</span>
                  <div className="ai-code-actions">
                    {isShell && onUseCommand && (
                      <button
                        type="button"
                        className="ai-mini-btn"
                        title="Stage in Terminal"
                        onClick={() => onUseCommand(raw)}
                      >
                        <Terminal size={12} />
                        Stage in Terminal
                      </button>
                    )}
                    {isShell && onRunCommand && (
                      <button
                        type="button"
                        className="ai-mini-btn"
                        title="Run in Terminal"
                        onClick={() => onRunCommand(raw)}
                      >
                        <Play size={12} />
                        Run in Terminal
                      </button>
                    )}
                    <CopyButton text={raw} />
                  </div>
                </div>
                <pre className="ai-code-pre">
                  <HighlightedCode code={raw} lang={lang} />
                </pre>
              </div>
            );
          },
        }}
      >
        {linked}
      </ReactMarkdown>
    </div>
  );
}
