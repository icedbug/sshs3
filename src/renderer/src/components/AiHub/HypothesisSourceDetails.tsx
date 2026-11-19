import { useEffect, useState } from "react";
import type { AnswerSource } from "@shared/answerSources";
import type { HypothesisSource } from "@shared/types/aiHub";
import { hubSessionGeneration } from "../../lib/aiHubSession";
import { AnswerSourceDetails } from "./AnswerSources";

const kinds: Record<HypothesisSource["kind"], string> = {
  "kb-page": "KB page", "kb-document": "KB document", memory: "Memory", terminal: "Terminal excerpt", "server-reading": "Server reading",
};

export function HypothesisSourceDetails({ pointer }: { pointer: HypothesisSource }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<AnswerSource>();
  const [unavailable, setUnavailable] = useState(false);
  const { taskId, callId, ref, digest } = pointer;
  useEffect(() => {
    if (!open) return;
    let current = true;
    const session = hubSessionGeneration();
    setSource(undefined);
    setUnavailable(false);
    void (async () => {
      try {
        const response = await window.multissh.aiHubRequest({ action: "task-read", taskId, detail: "evidence-source", callId, ref, digest });
        if (!current || session !== hubSessionGeneration()) return;
        const found = response.reply?.evidenceSource;
        if (found?.callId === callId && found.source.ref === ref && found.source.digest === digest) setSource(found.source);
        else setUnavailable(true);
      } catch {
        if (current && session === hubSessionGeneration()) setUnavailable(true);
      }
    })();
    return () => { current = false; };
  }, [open, taskId, callId, ref, digest]);

  return (
    <div>
      <button type="button" className="ai-chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        {kinds[pointer.kind]}{pointer.revision !== undefined ? ` v${pointer.revision}` : ""} · {ref}
      </button>
      {open && (source ? <AnswerSourceDetails source={source} /> :
        <small>{unavailable ? "This source is unavailable in your workspace." : "Loading source…"}</small>)}
    </div>
  );
}
