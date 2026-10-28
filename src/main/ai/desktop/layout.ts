import type { NativeHermesMode, NativeHermesState } from '../../../shared/types/nativeHermes';

export function parseDesktopState(input: unknown): NativeHermesState {
  const value = input as Partial<NativeHermesState> | null;
  const mode: NativeHermesMode = value && ['closed', 'panel', 'full'].includes(value.mode ?? '')
    ? value.mode as NativeHermesMode : 'panel';
  const width = typeof value?.width === 'number' && Number.isFinite(value.width)
    ? Math.max(280, Math.min(640, Math.round(value.width))) : 380;
  return { mode, width };
}

export function desktopGeometry(state: NativeHermesState, bounds: { width: number; height: number }) {
  const width = Math.max(0, Math.floor(bounds.width));
  const height = Math.max(0, Math.floor(bounds.height));
  const chatWidth = Math.min(state.width, Math.max(280, width - 320), width);
  return {
    terminal: { x: 0, y: 0, width: state.mode === 'closed' ? width : Math.max(0, width - chatWidth), height },
    chatWidth: state.mode === 'full' ? width : chatWidth,
    visible: state.mode !== 'full',
  };
}
