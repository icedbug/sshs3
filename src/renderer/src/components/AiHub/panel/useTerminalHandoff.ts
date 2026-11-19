import { useCallback, useRef, useState } from "react";
import type { TerminalSession } from "@shared/types/aiHub";

interface TerminalDraft {
  taskId: string;
  messageId: string;
  line: number;
  text: string;
  target?: Pick<TerminalSession, "id" | "generation" | "label">;
}

/** Terminal input explicitly requested by the user from the AI workspace. */
export function useTerminalHandoff(
  taskId: string,
  session: TerminalSession | undefined,
  setError: (message: string) => void,
  setNotice: (message: string) => void,
) {
  const [stored, setDraft] = useState<TerminalDraft | null>(null);
  const draft = stored?.taskId === taskId ? stored : null;
  const [writing, setWriting] = useState(false);
  const pending = useRef(false);
  const epoch = useRef(0);

  const reset = useCallback((): void => {
    epoch.current++;
    pending.current = false;
    setWriting(false);
    setDraft(null);
  }, []);

  async function write(command: string, run: boolean): Promise<boolean> {
    setNotice("");
    if (!session) {
      setError("The selected terminal is no longer available. Select a current terminal first.");
      return false;
    }
    const api = window.multissh;
    const send = session.kind === "k8s" ? api?.k8sTerminalWrite : api?.terminalWrite;
    if (!send) {
      setError("This terminal cannot accept input.");
      return false;
    }
    const started = epoch.current;
    try {
      const text = run ? command.replace(/\r\n?/g, "\n") : command;
      await send(session.id, run && !text.endsWith("\n") ? text + "\n" : text);
      if (started === epoch.current) {
        setError("");
        setNotice(run ? `Sent to ${session.label}.` : `Staged in ${session.label}.`);
      }
      return true;
    } catch (error) {
      if (started === epoch.current) setError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  const connected = Boolean(draft?.target && session &&
    draft.target.id === session.id && draft.target.generation === session.generation);
  const hasControl = Boolean(draft && Array.from(draft.text).some((ch) =>
    ch !== "\n" && ch !== "\t" && (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127),
  ));

  async function runDraft(): Promise<boolean> {
    if (!draft || pending.current || hasControl || !draft.text.trim()) return false;
    if (!connected) {
      setError("The selected terminal is no longer available. Stage the command again in a current terminal.");
      return false;
    }
    const started = epoch.current;
    pending.current = true;
    setWriting(true);
    try {
      const written = await write(draft.text, true);
      if (written) setDraft((current) => current === draft ? null : current);
      return written;
    } finally {
      if (started === epoch.current) {
        pending.current = false;
        setWriting(false);
      }
    }
  }

  function forMessage(messageId: string | undefined) {
    // A clipped snapshot can start halfway through the source. Wait for its full text to number fences.
    if (messageId === undefined) return undefined;
    return {
      stage(command: string, line: number): void {
        if (pending.current) return;
        if (!session || Array.from(command).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
          const target = session && { id: session.id, generation: session.generation, label: session.label };
          setDraft({ taskId, messageId, line, target, text: command.replace(/\r\n?/g, "\n") });
          setError("");
          setNotice("");
        } else {
          void write(command, false);
        }
      },
      run(command: string, line: number): void {
        if (draft?.messageId === messageId && draft.line === line) void runDraft();
        else void write(command, true);
      },
    };
  }

  function edit(text: string): void {
    setDraft((current) => current && { ...current, text });
  }

  return { draft, connected, hasControl, writing, edit, reset, runDraft, forMessage, run: (command: string) => write(command, true) };
}
