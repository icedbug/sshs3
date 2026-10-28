import { stripVTControlCharacters } from "node:util";

/** Mask BEFORE clipping. Call on complete records, not individual transport chunks. */
export function maskContext(value: string): string {
  return stripVTControlCharacters(value)
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
      "[private key redacted]",
    )
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g,
      "[redacted]",
    )
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /(["']?[\w-]*(?:password|passphrase|passwd|secret|token|api[_-]?key|credential)[\w-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1[redacted]",
    );
}

export function boundedContext(value: string, max = 32_000): string {
  const clean = maskContext(value);
  return clean.length > max
    ? `[earlier output omitted]\n${clean.slice(-max)}`
    : clean;
}

export function safeError(error: unknown): string {
  return boundedContext(
    error instanceof Error ? error.message : String(error),
    2000,
  );
}
