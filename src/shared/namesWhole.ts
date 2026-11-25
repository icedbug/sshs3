/**
 * Whether a name stands in a text as a whole word, as a server's name or address does in a plan
 * step's target: "web-02" does in "web-02 (staging): /tmp/x" and in "ops@web-02:/etc", not in
 * "web-020" or in the other host "web-02.example.com". Letters are compared without case.
 */
export function namesWhole(text: string, name: string | undefined): boolean {
  const t = text.toLowerCase();
  const n = name?.trim().toLowerCase();
  if (!n) return false;
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + 1)) {
    const before = i > 0 ? t[i - 1] : "";
    const after = t.slice(i + n.length, i + n.length + 2);
    if (!/[a-z0-9_.-]/.test(before) && !/^(?:[a-z0-9_-]|\.[a-z0-9_-])/.test(after)) return true;
  }
  return false;
}
