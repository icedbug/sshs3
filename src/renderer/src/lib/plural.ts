/** "1 session", "2 sessions": the count and the right form of the noun in one string (English plurals only). */
export function plural(count: number, singular: string, pluralForm: string = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
