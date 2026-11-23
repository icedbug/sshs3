import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import type { PanelState } from "./usePanelState";

/**
 * What is attached, and the text box with its slash commands and @ mentions.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function ComposerInput({ p }: { p: PanelState }): JSX.Element {
  const {
    attachments,
    setAttachments,
    attachFileOrImage,
    activeSlashSuggestions,
    atIndex,
    applySlashSuggestion,
    activeAtSuggestions,
    applyAtSuggestion,
    composer,
    task,
    prompt,
    setPrompt,
    setAtIndex,
    setAtDismissedFor,
    cycleMode,
    submit,
    fileInput,
    running,
    busy,
    act,
  } = p;
  return (
    <>
                {attachments.length > 0 && (
                  <div className="ai-attachments">
                    {attachments.map((a) => (
                      <button
                        className="ai-attachment"
                        key={a.id}
                        title={"Remove " + a.label}
                        onClick={() =>
                          setAttachments((all) =>
                            all.filter((x) => x.id !== a.id),
                          )
                        }
                      >
                        {a.imageDataUrl ? (
                          <img
                            src={a.imageDataUrl}
                            alt={a.label}
                            style={{
                              width: "20px",
                              height: "20px",
                              borderRadius: "4px",
                              objectFit: "cover",
                            }}
                          />
                        ) : (
                          <Paperclip size={11} />
                        )}
                        {a.label}
                        <X size={11} />
                      </button>
                    ))}
                  </div>
                )}
                <div
                  className="ai-input-box"
                  style={{ position: "relative" }}
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types?.includes("Files")) {
                      e.preventDefault();
                    }
                  }}
                  onDrop={(e) => {
                    const files = Array.from(e.dataTransfer?.files ?? []);
                    if (files.length > 0) {
                      e.preventDefault();
                      for (const f of files) attachFileOrImage(f);
                    }
                  }}
                >
                  {activeSlashSuggestions.length > 0 && (
                    <div
                      className="ai-popover"
                      data-testid="ai-slash-palette"
                      aria-label="Slash command palette"
                      style={{
                        bottom: "calc(100% + 6px)",
                        left: 0,
                        right: 0,
                        width: "100%",
                        zIndex: 46,
                      }}
                    >
                      <strong>Commands (Tab / Enter)</strong>
                      {activeSlashSuggestions.map((item, idx) => (
                        <button
                          key={item.cmd}
                          type="button"
                          aria-current={
                            idx === atIndex % activeSlashSuggestions.length
                              ? "true"
                              : undefined
                          }
                          onClick={() => applySlashSuggestion(item)}
                        >
                          <span>
                            <code>{item.cmd}</code> · {item.title}
                          </span>
                          <small>{item.subtitle}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  {activeAtSuggestions.length > 0 && (
                    <div
                      className="ai-popover"
                      data-testid="ai-at-autocomplete"
                      aria-label="Autocomplete @ mention"
                      style={{
                        bottom: "calc(100% + 6px)",
                        left: 0,
                        right: 0,
                        width: "100%",
                        zIndex: 45,
                      }}
                    >
                      <strong>@ Context autocomplete (Tab / Enter)</strong>
                      {activeAtSuggestions.map((opt, idx) => (
                        <button
                          key={opt.label}
                          type="button"
                          aria-current={
                            idx === atIndex % activeAtSuggestions.length
                              ? "true"
                              : undefined
                          }
                          onClick={() => applyAtSuggestion(opt)}
                        >
                          {opt.label}
                          <small>{opt.subtitle}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={composer}
                    data-testid="ai-composer"
                    aria-label="Message to agent"
                    placeholder={
                      task
                        ? "Reply in this conversation… (type !cmd to run in terminal, / for commands, @ for context)"
                        : "Ask anything to start a new conversation… (type !cmd to run in terminal, / for commands, Shift+Tab to cycle mode)"
                    }
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      setAtIndex(0);
                      setAtDismissedFor(null);
                    }}
                    onPaste={(e) => {
                      const items = Array.from(e.clipboardData?.items ?? []);
                      const imageFiles: File[] = [];
                      for (const item of items) {
                        if (item.kind === "file" && item.type.startsWith("image/")) {
                          const f = item.getAsFile();
                          if (f) imageFiles.push(f);
                        }
                      }
                      if (imageFiles.length > 0) {
                        e.preventDefault();
                        for (const f of imageFiles) attachFileOrImage(f);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Tab" && e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        cycleMode();
                        return;
                      }
                      if (activeSlashSuggestions.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setAtIndex((i) => (i + 1) % activeSlashSuggestions.length);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setAtIndex(
                            (i) =>
                              (i - 1 + activeSlashSuggestions.length) %
                              activeSlashSuggestions.length,
                          );
                          return;
                        }
                        if (
                          (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          const chosen =
                            activeSlashSuggestions[
                              atIndex % activeSlashSuggestions.length
                            ];
                          if (chosen) applySlashSuggestion(chosen);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setAtDismissedFor(prompt);
                          return;
                        }
                      }
                      if (activeAtSuggestions.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setAtIndex((i) => (i + 1) % activeAtSuggestions.length);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setAtIndex(
                            (i) =>
                              (i - 1 + activeAtSuggestions.length) %
                              activeAtSuggestions.length,
                          );
                          return;
                        }
                        if (
                          (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          const chosen =
                            activeAtSuggestions[
                              atIndex % activeAtSuggestions.length
                            ];
                          if (chosen) applyAtSuggestion(chosen);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setAtDismissedFor(prompt);
                          return;
                        }
                      }
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <div className="ai-input-tools">
                    <button
                      className="ai-icon-button"
                      aria-label="Attach image or text file"
                      title="Attach image (PNG/JPG/WebP) or text file, or paste with Ctrl+V"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip size={16} />
                    </button>
                    <small>Enter to send · Ctrl+V to paste screenshot</small>
                    {running && !prompt.trim() && !attachments.some((a) => !!a.imageDataUrl) ? (
                      <button
                        className="ai-send ai-stop"
                        aria-label="Stop response"
                        title="Stop response"
                        disabled={busy}
                        onClick={() =>
                          void act({ action: "stop", taskId: task!.id })
                        }
                      >
                        <Square size={12} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className="ai-send"
                        aria-label="Send message"
                        title="Send message"
                        disabled={
                          busy ||
                          (!prompt.trim() &&
                            !attachments.some((a) => !!a.imageDataUrl))
                        }
                        onClick={() => void submit()}
                      >
                        <ArrowUp size={17} />
                      </button>
                    )}
                  </div>
                </div>
    </>
  );
}
