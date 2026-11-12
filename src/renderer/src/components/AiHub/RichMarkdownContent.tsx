import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkRefs } from "./reportRefs";

export function RichMarkdownContent({
  text,
  onUseCommand,
  refs,
  onOpenRef,
}: {
  text: string;
  onUseCommand?: (cmd: string) => void;
  /** The short names of this conversation's commands; `[c3]` in the text becomes a link to that command. */
  refs?: ReadonlySet<string>;
  onOpenRef?: (ref: string) => void;
}) {
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null);

  const handleCopy = (code: string) => {
    void navigator.clipboard?.writeText(code);
    setCopiedBlock(code);
    setTimeout(() => setCopiedBlock((prev) => (prev === code ? null : prev)), 1800);
  };

  return (
    <div className="ai-message-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const ref = /^#ref-(c\d+)$/.exec(href ?? "")?.[1];
            if (ref)
              return (
                <button
                  type="button"
                  className="ai-ref"
                  title="Show the command and its output"
                  onClick={() => onOpenRef?.(ref)}
                >
                  {children}
                </button>
              );
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="ai-table-wrap">
                <table className="ai-md-table">{children}</table>
              </div>
            );
          },
          code({ className, children, ...props }) {
            const raw = String(children ?? "").replace(/\n$/, "");
            const langMatch = /language-([a-zA-Z0-9_-]+)/.exec(className || "");
            const isBlock = Boolean(langMatch) || raw.includes("\n");
            if (!isBlock) {
              return (
                <code className="ai-inline-code" {...props}>
                  {children}
                </code>
              );
            }
            const lang = (langMatch?.[1] || "shell").toLowerCase();
            const isDiff =
              lang === "diff" ||
              (raw.includes("---") && raw.includes("+++")) ||
              raw.split("\n").some((l) => l.startsWith("@@ "));
            const isShell = ["bash", "sh", "shell", "zsh", "powershell", "cmd", "ontap-cli"].includes(
              lang,
            );
            return (
              <div className="ai-code-block">
                <div className="ai-code-header">
                  <span className="ai-code-lang">{lang}</span>
                  <div className="ai-code-actions">
                    {isShell && onUseCommand && (
                      <button
                        type="button"
                        className="ai-code-btn"
                        title="Infoga kommando i chatten / terminalen"
                        onClick={() => onUseCommand(raw)}
                      >
                        ▶️ Use
                      </button>
                    )}
                    <button
                      type="button"
                      className="ai-code-btn"
                      onClick={() => handleCopy(raw)}
                    >
                      {copiedBlock === raw ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
                <pre>
                  <code>
                    {isDiff
                      ? raw.split("\n").map((line, i) => {
                          const cls =
                            line.startsWith("+") && !line.startsWith("+++")
                              ? "ai-diff-line-add"
                              : line.startsWith("-") && !line.startsWith("---")
                                ? "ai-diff-line-del"
                                : line.startsWith("@@")
                                  ? "ai-diff-line-hunk"
                                  : undefined;
                          return (
                            <span key={i} className={cls}>
                              {line}
                              {"\n"}
                            </span>
                          );
                        })
                      : raw}
                  </code>
                </pre>
              </div>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
        }}
      >
        {refs ? linkRefs(text, refs) : text}
      </ReactMarkdown>
    </div>
  );
}
