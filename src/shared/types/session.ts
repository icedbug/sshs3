import type { SSHConnectionConfig, LocalShellType } from './ssh';
import type { StorageType, FileEntry } from './storage';
import type { K8sTerminalTarget } from './kubernetes';

/** 'row' places children side by side (a vertical divider); 'column' stacks them (a horizontal divider). */
export type PaneOrientation = 'row' | 'column';

export interface PaneLeaf {
  type: 'leaf';
  id: string;
  config?: SSHConnectionConfig;
  /** True when this pane runs a local shell instead of an SSH connection. */
  local?: boolean;
  /** Set when this pane is an interactive exec session into a Kubernetes/OpenShift container. */
  k8sTarget?: K8sTerminalTarget;
  /** Set when this pane is a read-only follow view of a Kubernetes/OpenShift container's logs. */
  k8sLogTarget?: K8sTerminalTarget;
  /** Windows only: which local shell to spawn when `local` is set. */
  shellType?: LocalShellType;
  /** Windows only: specific WSL distribution to launch. */
  wslDistro?: string;
  /** Base hostname detected when the session started. */
  baseHost?: string;
  /** Dynamically updated hostname if user SSH'd further to another host. */
  dynamicHost?: string;
}

export interface PaneSplit {
  type: 'split';
  id: string;
  orientation: PaneOrientation;
  children: PaneNode[];
  /** Relative flex-grow weight per child, parallel to `children` (§23) — absent or
   * length-mismatched means "equal split", so older saved sessions restore unchanged. Only the
   * 2-child case is user-resizable today (PaneTree.tsx); a 3+-child split still renders equally
   * sized panes regardless of this field. */
  weights?: number[];
}

/**
 * A recursive tree of terminal panes, mirroring Konsole's ViewSplitter model: splitting wraps an
 * existing leaf (or inserts a sibling into an already-matching-orientation split) without ever
 * recreating it, and closing a pane collapses any split left with a single child back into that
 * child so no dead single-child nodes accumulate.
 */
export type PaneNode = PaneLeaf | PaneSplit;

export interface SavedTab {
  id: string;
  type: 'terminal' | 'filemanager' | 'editor';
  title: string;
  /** Terminal tabs always carry a pane tree, even when it's a single leaf. */
  paneTree?: PaneNode;
  /** The pane the user last interacted with; keyboard shortcuts (split/close) target this pane. */
  activePaneId?: string;
  initialCwd?: string;
  /** Set when saving/restoring an editor tab. */
  editorEntry?: FileEntry;
  editorProviderId?: string;
  editorSourceType?: StorageType;
  editorInitialMode?: 'source' | 'preview';
  editorTailMode?: boolean;
}

export interface SavedPaneState {
  sourceType: StorageType;
  providerId: string;
  label: string;
  path: string;
}

/** Window position and size in screen coordinates (DIPs). */
export interface SavedWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A secondary window: the main window keeps using the top-level `tabs`/`activeTabId` of SessionData. */
export interface SavedWindow {
  /** Stable id of the window across restarts. */
  key: string;
  bounds?: SavedWindowBounds;
  maximized?: boolean;
  tabs: SavedTab[];
  activeTabId: string;
}

export interface SessionData {
  tabs: SavedTab[];
  activeTabId: string;
  /** Position of the main window (the one whose tabs are the top-level `tabs`). */
  mainBounds?: SavedWindowBounds;
  mainMaximized?: boolean;
  /** Secondary windows, restored after the main one. */
  windows?: SavedWindow[];
  lastPaths?: Record<string, string>;
  panes?: {
    left: SavedPaneState;
    right: SavedPaneState;
  };
}
