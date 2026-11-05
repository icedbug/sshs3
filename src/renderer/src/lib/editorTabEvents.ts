import type { FileEntry } from '@shared/types/storage';
import type { SourceType } from '../components/FileManager/types';

export const OPEN_EDITOR_TAB_EVENT = 'sshs3:open-editor-tab';

export interface OpenEditorTabDetail {
  providerId: string;
  sourceType: SourceType;
  entry: FileEntry;
  initialMode?: 'source' | 'preview';
  isTailMode?: boolean;
  initialContent?: string;
}

export function openEditorTab(detail: OpenEditorTabDetail): void {
  window.dispatchEvent(new CustomEvent<OpenEditorTabDetail>(OPEN_EDITOR_TAB_EVENT, { detail }));
}
