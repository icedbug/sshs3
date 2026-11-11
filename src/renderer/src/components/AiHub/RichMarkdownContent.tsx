import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function RichMarkdownContent({
  text,
  onUseCommand,
}: {
  text: string;
  onUseCommand?: (cmd: string) => void;
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
                      {copiedBlock === raw ? "✓ Kopierad" : "📋 Kopiera"}
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
        {text}
      </ReactMarkdown>
    </div>
  );
}
