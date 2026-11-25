/**
 * A time as people read it in a message that may reach anybody, anywhere: "2026-11-25 20:15 UTC". A message
 * the hub writes does not know the reader's time zone; this says which one it is in.
 */
export function utcMinute(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The time after "until " in a message, written by `utcMinute` or as an ISO string (as older messages are). */
export function untilIn(text: string): number | undefined {
  const found = /until (\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?Z?(?: UTC)?/.exec(text);
  if (!found) return undefined;
  const at = Date.parse(`${found[1]}T${found[2]}:${found[3] ?? "00"}${found[4] ? `.${found[4]}` : ""}Z`);
  return Number.isFinite(at) ? at : undefined;
}
