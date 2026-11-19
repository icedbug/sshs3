import type { AiPiiScrubbingMode } from "../../../shared/types/ai";
import { maskProviderText } from "./privacy";

const WIRE_FIELDS = new Set(["model", "id", "call_id", "tool_use_id", "tool_call_id", "type", "role", "name", "media_type", "signature", "encrypted_content"]);
const SECRET_FIELDS = /^(?:password|passphrase|passwd|secret|clientsecret|apikey|(?:access|refresh|auth|session|bearer)?token|authorization|credential)$/i;

/** Keep wire IDs, binary images and signed reasoning intact. Apply the data policy before serializing the request. */
export function modelRequestBody(payload: Record<string, unknown>, mode?: AiPiiScrubbingMode, hosts?: ReadonlySet<string>): string {
  const text = (value: string) => maskProviderText(value, mode, hosts);
  function data(value: unknown): unknown {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(data);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([field, v]) => [
      field, SECRET_FIELDS.test(field.replace(/[-_]/g, "")) && typeof v === "string" ? "[redacted]" : data(v),
    ]));
  }
  function clean(value: unknown, key = ""): unknown {
    if (typeof value === "string") {
      if (WIRE_FIELDS.has(key) || value.startsWith("data:image/") && (key === "url" || key === "image_url")) return value;
      if (key === "arguments") {
        try {
          const args: unknown = JSON.parse(value);
          const masked = JSON.stringify(data(args));
          return masked === JSON.stringify(args) ? value : masked;
        } catch { /* An incomplete argument is returned to the model as an error. */ }
      }
      return text(value);
    }
    if (Array.isArray(value)) return value.map((entry) => clean(entry, key));
    if (!value || typeof value !== "object") return value;
    const item = value as Record<string, unknown>;
    if (item.type === "thinking" || item.type === "redacted_thinking") return item;
    if (item.type === "base64" && typeof item.media_type === "string" && item.media_type.startsWith("image/")) return item;
    return Object.fromEntries(Object.entries(item).map(([field, v]) => [
      field, item.type === "tool_use" && field === "input" ? data(v) : clean(v, field),
    ]));
  }
  return JSON.stringify(clean(payload));
}
