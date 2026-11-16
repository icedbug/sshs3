/** Copies text to the system clipboard, returning true on success. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback.
  }
  try {
    if (typeof document === "undefined" || !document.body) return false;
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    try {
      area.select();
      return typeof document.execCommand === "function" ? document.execCommand("copy") : false;
    } finally {
      document.body.removeChild(area);
    }
  } catch {
    return false;
  }
}
