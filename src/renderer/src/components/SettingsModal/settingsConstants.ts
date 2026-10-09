import { type AppSettings } from '@shared/types/settings';

export interface FontPreset {
  label: string;
  value: string;
}

export const FONT_PRESETS: FontPreset[] = [
  { label: 'JetBrains Mono (Bundled)', value: 'JetBrains Mono, monospace' },
  { label: 'Fira Code (Bundled)', value: 'Fira Code, monospace' },
  { label: 'Consolas (Windows)', value: 'Consolas, "Courier New", monospace' },
  { label: 'Menlo (macOS)', value: 'Menlo, Monaco, "Courier New", monospace, Consolas' },
  { label: 'Liberation Mono (Linux)', value: 'Liberation Mono, monospace' },
  { label: 'Ubuntu Mono (Linux)', value: 'Ubuntu Mono, monospace' },
  { label: 'System Default Monospace', value: 'monospace' },
];

export type SettingsCategory = 'general' | 'terminal' | 'performance' | 'files' | 'security' | 'sync' | 'shortcuts' | 'kubernetes' | 'git' | 'ai';

/** 'app-managed' is a legacy alias of 'auto' that the select no longer offers. */
export const normalizeAgentMode = (mode: AppSettings['localTerminalAgentMode']) =>
  !mode || mode === 'app-managed' ? 'auto' : mode;
