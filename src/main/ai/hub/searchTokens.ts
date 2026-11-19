export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9åäö_.-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}
