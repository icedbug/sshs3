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

/**
 * Copies text and throws when it could not be copied: the same promise as `navigator.clipboard.writeText`,
 * for callers that show "copied" when it resolves. Unlike it, this also works on a page served over plain
 * http, where the browser gives pages no clipboard: `copyToClipboard` then copies through a hidden field.
 */
export async function writeClipboardText(text: string): Promise<void> {
  if (!text) return;
  if (!(await copyToClipboard(text))) throw new Error("Could not copy to the clipboard.");
}
