/** Immutable references to the material present in one model request. */
export interface AnswerSource {
  ref: string;
  kind: "kb-page" | "kb-document" | "memory" | "terminal" | "server-reading";
  id: string;
  label: string;
  revision?: number;
  updatedAt?: number;
  observedAt?: number;
  /** An index entry names a source without opening its body. */
  indexOnly?: true;
  /** This excerpt was supplied as an attachment. */
  attachment?: true;
  /** A bounded, masked preview is kept for terminal evidence and server readings. */
  excerpt?: string;
  excerptTruncated?: true;
  /** Exact masked terminal spans retained in the request, in reading order. */
  segments?: string[];
  /** Terminal details outside the workspace retention window. */
  expired?: true;
  /** SHA-256 of the included text after applying the provider's data policy. */
  digest: string;
}

export interface StoredSourceSpan {
  from: number;
  to: number;
  source: Omit<AnswerSource, "ref" | "digest" | "excerpt" | "excerptTruncated" | "segments">;
}

export interface AnswerSourceCall {
  id: string;
  at: number;
  sources: AnswerSource[];
  /** A retained historical tool result predates the recording of source identities. */
  untracedHistory?: true;
}

/** Keep each distinct terminal payload once in this answer's persisted detail. */
export function appendSourceCalls(existing: AnswerSourceCall[], incoming: AnswerSourceCall[]): void {
  const known = new Set(existing.flatMap(c => c.sources.filter(s => s.segments).map(s => s.digest)));
  for (const c of incoming) {
    existing.push({ ...c, sources: c.sources.map(s => {
      if (!s.segments) return s;
      if (!known.has(s.digest)) { known.add(s.digest); return s; }
      const { segments: _segments, ...ref } = s;
      return ref;
    }) });
  }
}

export function sourceCallsForDisplay(calls: AnswerSourceCall[] = []): AnswerSourceCall[] {
  const segments = new Map<string, string[]>();
  return calls.map(c => ({ ...c, sources: c.sources.map(s => {
    if (s.segments) segments.set(s.digest, s.segments);
    const saved = s.kind === "terminal" && !s.expired ? segments.get(s.digest) : undefined;
    return saved && !s.segments ? { ...s, segments: saved } : s;
  }) }));
}


/** A long-running chat can outlive terminal history retention. Keep its locator and digest after expiry. */
export function expireTerminalSources(calls: AnswerSourceCall[], cutoff: number): AnswerSourceCall[] {
  const expires = (s: AnswerSource, call: AnswerSourceCall) => (s.kind === "terminal" || s.kind === "server-reading") && (s.observedAt ?? call.at) < cutoff;
  if (!calls.some(c => c.sources.some(s => !s.expired && expires(s, c)))) return calls;
  const compact: AnswerSourceCall[] = [];
  for (const call of sourceCallsForDisplay(calls)) appendSourceCalls(compact, [{ ...call, sources: call.sources.map(s => {
    if (!expires(s, call)) return s;
    const { segments: _segments, excerpt: _excerpt, excerptTruncated: _truncated, ...rest } = s;
    return { ...rest, expired: true as const };
  }) }]);
  return compact;
}
