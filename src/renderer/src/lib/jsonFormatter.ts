/**
 * Pure helper function to validate and format JSON strings.
 */
export interface JsonFormatResult {
  success: boolean;
  formatted?: string;
  error?: string;
}

export function formatJson(text: string, indent = 2): JsonFormatResult {
  if (!text.trim()) {
    return { success: true, formatted: text };
  }
  try {
    const parsed = JSON.parse(text);
    const formatted = JSON.stringify(parsed, null, indent);
    return { success: true, formatted };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Invalid JSON syntax',
    };
  }
}
