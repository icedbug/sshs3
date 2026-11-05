export interface DocsLintFinding {
  file: string;
  line: number;
  level: 'error' | 'warn';
  rule: string;
  message: string;
}
export interface DocsLintContext {
  knownPages?: Set<string> | null;
  shortcuts?: Set<string> | null;
  images?: Set<string> | null;
}
export function stripInlineCode(line: string): string;
export function kbdCombos(line: string): string[];
export function lintDoc(file: string, text: string, ctx?: DocsLintContext): DocsLintFinding[];
export function parseShortcuts(settingsSource: string): Set<string>;
export function parseRegistrySlugs(buildDocsSource: string): Set<string>;
