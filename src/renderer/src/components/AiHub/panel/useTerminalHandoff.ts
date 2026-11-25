import { useCallback, useRef, useState } from "react";
import type { TerminalSession } from "@shared/types/aiHub";
import { hubRequest } from "../../../lib/aiHub";

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
  // The command, and the terminal, a person was told about during a change freeze. Pressing Run in Terminal on
  // that command in that terminal again runs it.
  const confirming = useRef<string | null>(null);

  const reset = useCallback((): void => {
    epoch.current++;
    pending.current = false;
    confirming.current = null;
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

  /**
   * A command from an answer or a runbook is run as the person, so no approval is asked. The hub still checks it
   * against a change freeze on the terminal's server, asks the person once more during one, and writes in the
   * audit log that it is about to be typed. What it answers is undefined when the command is not to be typed now.
   */
  async function cleared(command: string, key: string, from: "answer" | "runbook"): Promise<{ intentId?: string } | undefined> {
    if (!session) {
      setError("The selected terminal is no longer available. Select a current terminal first.");
      return undefined;
    }
    // A freeze said about one terminal is not said about another: the terminal is part of what was said.
    const said = `${session.id}\n${session.generation}\n${key}`;
    const confirmFreeze = confirming.current === said;
    const started = epoch.current;
    try {
      const { reply } = await hubRequest({
        action: "answer-command",
        sessionId: session.id,
        command,
        ...(from === "runbook" ? { from } : taskId ? { taskId } : {}),
        ...(confirmFreeze ? { confirmFreeze: true } : {}),
      });
      const answer = reply?.answerCommand;
      if (answer && !answer.cleared) {
        // Only a warning the person saw counts as said: one that arrives after they left is not shown.
        if (started === epoch.current) {
          confirming.current = said;
          setNotice("");
          setError(
            `A change freeze holds on ${answer.label ?? session.label} until ${new Date(answer.frozenUntil ?? Date.now()).toLocaleString()}. ` +
              "Run in Terminal types the command as you, past the freeze, and it is written in the audit log. " +
              "Press Run in Terminal again to run it anyway.",
          );
        }
        return undefined;
      }
      confirming.current = null;
      return { ...(answer?.intentId ? { intentId: answer.intentId } : {}) };
    } catch (error) {
      if (started === epoch.current) setError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  /** Types a command the hub cleared, and tells the hub whether the terminal took it: the audit log's second line. */
  async function runCleared(command: string, key: string, from: "answer" | "runbook"): Promise<boolean> {
    const go = await cleared(command, key, from);
    if (!go) return false;
    const written = await write(command, true);
    if (go.intentId)
      void hubRequest({ action: "answer-command-typed", intentId: go.intentId, typed: written }).catch(() => undefined);
    return written;
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
      const written = await runCleared(draft.text, `${draft.messageId}:${draft.line}:${draft.text}`, "answer");
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
        else void runCleared(command, `${messageId}:${line}:${command}`, "answer");
      },
    };
  }

  function edit(text: string): void {
    setDraft((current) => current && { ...current, text });
  }

  return {
    draft,
    connected,
    hasControl,
    writing,
    edit,
    reset,
    runDraft,
    forMessage,
    /** A runbook step from the knowledge base: asked about during a freeze and written down, as an answer's command is. */
    runStep: (command: string) => runCleared(command, `runbook:${command}`, "runbook"),
    /** The person's own command from the composer (`!command`): typed as they would type it, without asking. */
    run: (command: string) => write(command, true),
  };
}
