import type { LogLevel } from './log';
import { DEFAULT_K8S_DEBUG_IMAGES, type K8sDebugImage } from './kubernetes';
import { DEFAULT_PERF_ITEMS, type PerfLayout, type PerfMetricId } from './perf';

export type AppTheme = 'dark' | 'light' | 'breeze' | 'system';
export type SessionExitAction = 'reconnect' | 'close' | 'keep';

export interface ShortcutDefinition {
  id: string;
  name: string;
  defaultKeys: string;
  category: 'Tabs' | 'Terminal' | 'General';
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: 'newTerminal', name: 'New Terminal', defaultKeys: 'Ctrl+Shift+T', category: 'Tabs' },
  { id: 'newFileManager', name: 'New File Manager', defaultKeys: 'Ctrl+Shift+F', category: 'Tabs' },
  { id: 'closeTab', name: 'Close Tab', defaultKeys: 'Ctrl+W', category: 'Tabs' },
  { id: 'nextTab', name: 'Next Tab', defaultKeys: 'Ctrl+Tab', category: 'Tabs' },
  { id: 'prevTab', name: 'Previous Tab', defaultKeys: 'Ctrl+Shift+Tab', category: 'Tabs' },
  { id: 'openProfiles', name: 'Connection Manager', defaultKeys: 'Ctrl+Shift+O', category: 'General' },
  { id: 'openSettings', name: 'Settings', defaultKeys: 'Ctrl+,', category: 'General' },
  { id: 'navigateLeft', name: 'Navigate Left (Split / Panel)', defaultKeys: 'Ctrl+Shift+Left', category: 'General' },
  { id: 'navigateRight', name: 'Navigate Right (Split / Panel)', defaultKeys: 'Ctrl+Shift+Right', category: 'General' },
  { id: 'navigateUp', name: 'Navigate Up (Split / To Tabs)', defaultKeys: 'Ctrl+Shift+Up', category: 'General' },
  { id: 'navigateDown', name: 'Navigate Down (Split / Into Tab)', defaultKeys: 'Ctrl+Shift+Down', category: 'General' },
  { id: 'splitVertical', name: 'Split Terminal Vertically', defaultKeys: 'Ctrl+Shift+D', category: 'Terminal' },
  { id: 'splitHorizontal', name: 'Split Terminal Horizontally', defaultKeys: 'Ctrl+Shift+E', category: 'Terminal' },
  // Letters, not punctuation: Shift+<punctuation key> produces a different character on
  // different keyboard layouts (e.g. Shift+, is '<' on a US layout, ';' on Swedish/Nordic
  // ISO layouts), and matching that reliably across every layout/browser combo isn't
  // guaranteed. Letters don't have that problem — Shift+N is always reported as 'N'.
  { id: 'nextPane', name: 'Next Split Pane', defaultKeys: 'Ctrl+Shift+N', category: 'Terminal' },
  { id: 'prevPane', name: 'Previous Split Pane', defaultKeys: 'Ctrl+Shift+P', category: 'Terminal' },
  { id: 'increaseFontSize', name: 'Increase Font Size', defaultKeys: 'Ctrl++', category: 'Terminal' },
  { id: 'decreaseFontSize', name: 'Decrease Font Size', defaultKeys: 'Ctrl+-', category: 'Terminal' },
  { id: 'resetFontSize', name: 'Reset Font Size', defaultKeys: 'Ctrl+0', category: 'Terminal' },
  { id: 'clipboardHistory', name: 'Clipboard History', defaultKeys: 'Ctrl+Shift+R', category: 'Terminal' },
  { id: 'terminalSearch', name: 'Search in Terminal', defaultKeys: 'Ctrl+Shift+S', category: 'Terminal' },
  { id: 'copyLastOutput', name: 'Copy Last Command Output', defaultKeys: 'Ctrl+Shift+G', category: 'Terminal' },
  { id: 'snippets', name: 'Snippets', defaultKeys: 'Ctrl+Shift+L', category: 'Terminal' },
  { id: 'aiAssistant', name: 'AI Assistant', defaultKeys: 'Ctrl+Shift+A', category: 'Terminal' },
  { id: 'aiInlineCommand', name: 'AI: Turn Typed Text into a Command', defaultKeys: 'Ctrl+Shift+Space', category: 'Terminal' },
  { id: 'searchInFiles', name: 'Search in Files', defaultKeys: 'Ctrl+Shift+K', category: 'General' },
];

export const DEFAULT_SHORTCUTS: Record<string, string> = SHORTCUT_DEFINITIONS.reduce(
  (acc, def) => {
    acc[def.id] = def.defaultKeys;
    return acc;
  },
  {} as Record<string, string>
);

/**
 * Governs how PKCS#11 smartcard PIN entry is cached across the connections a
 * single "connect" action can open (the interactive terminal plus, when
 * enabled, a separate dotfiles-sync SFTP connection):
 * - 'always-prompt': no caching. Every connection that needs the smartcard
 *   prompts for the PIN fresh. Required when policy mandates re-authenticating
 *   the card on every login.
 * - 'agent-per-session': the PIN is entered once into a private, app-managed
 *   ssh-agent shared by that terminal connection and its dotfiles sync. The
 *   agent is scoped to that one terminal, not the app's lifetime — it's
 *   killed as soon as the terminal disconnects, so reconnecting (even within
 *   the same app run) asks for the PIN again.
 * - 'agent-global': the PIN is entered once per PKCS#11 library into a
 *   private, app-managed ssh-agent shared by every terminal, tab and profile
 *   using that same smartcard, for as long as the app keeps running. Least
 *   strict of the three: convenient, but the card stays usable by anything
 *   in the app (not just the connection that first unlocked it) until the
 *   app quits or the card is locked manually.
 */
export type SmartcardAuthMode = 'always-prompt' | 'agent-per-session' | 'agent-global';

export interface AppSettings {
  theme: AppTheme;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalCursorStyle?: 'block' | 'underline' | 'bar';
  terminalScrollback?: number;
  copyOnSelect?: boolean;
  /** Whether the terminal selection history is shared by all hosts ('global') or kept per connection ('host'). */
  clipboardHistoryScope?: 'global' | 'host';
  /** Wipe the clipboard history when the app quits (and on next start, in case it crashed). */
  clipboardHistoryClearOnExit?: boolean;
  defaultNewTabType: 'terminal' | 'filemanager';
  confirmBeforeDelete?: boolean;
  showHiddenFiles?: boolean;
  defaultConflictPolicy?: 'ask' | 'overwrite' | 'skip' | 'rename';
  /** Verify target file size and cryptographic checksum after file transfers. Default true. */
  verifyTransferIntegrity?: boolean;
  shortcuts?: Record<string, string>;
  /** Master switch for the dotfiles pool feature. Off by default — an opt-in feature, not a default-on behavior. */
  dotfilesPoolEnabled?: boolean;
  /** Smartcard PIN caching behavior, applied uniformly to every smartcard/PKCS#11 profile. */
  smartcardAuthMode?: SmartcardAuthMode;
  /**
   * 'agent-global' mode only: prompt for the smartcard PIN and unlock it into
   * the app-lifetime agent as soon as the app starts, instead of waiting for
   * the first connection that actually needs it. Only takes effect when
   * exactly one PKCS#11 library is detected on the system — with zero or
   * several candidates there's no single card to guess at unlocking.
   */
  smartcardUnlockAtStartup?: boolean;
  /**
   * The PKCS#11 driver to use for smartcard features that aren't tied to one profile — the startup
   * unlock and linking/unlocking Remote Profile Sync. Empty/undefined = auto-detect (first detected
   * module, or p11-kit when present). Profiles still use their own library path.
   */
  smartcardLibPath?: string;
  /** Action to take when a terminal session exits: 'reconnect' (show reconnect overlay), 'close' (auto-close tab on clean exit), or 'keep' (leave terminal open passively). */
  sessionExitAction?: SessionExitAction;
  /** Show a confirmation dialog before quitting the app (closing the window or Cmd/Ctrl+Q). Off by default. */
  confirmBeforeQuit?: boolean;
  /** Minimum level written to the log file (see src/main/log). SSHS3_LOG_LEVEL overrides it. Default 'info'. */
  logLevel?: LogLevel;
  /** Periodically check GitHub Releases for a new version (nothing is downloaded without a click). On by default. */
  autoCheckUpdates?: boolean;
  /** Windows only: Mode for local X11 server: 'manual' (external), 'auto' (start automatically when X11 session opens), 'always' (start on app launch) */
  x11ServerMode?: 'manual' | 'auto' | 'always';
  /** Windows only: Custom path to X server executable (e.g. C:\Program Files\VcXsrv\vcxsrv.exe). Auto-detects if omitted. */
  x11ServerPath?: string;
  /** Windows only: Custom arguments for X server (default: ':0 -multiwindow -clipboard -wgl -ac'). */
  x11ServerArgs?: string;
  /** ISO 8601 timestamp of the last edit. Used by remote profile sync to pick the newer whole-object copy. */
  updatedAt?: string;
  /** Master switch for OpenShift support and tools (e.g. oc login, oc CLI shim). Off by default. */
  enableOpenShift?: boolean;
  /**
   * SSH/SFTP and S3 profiles share one flat folder namespace on disk. Off by
   * default, the Connection Manager hides a folder from a tab unless it holds
   * at least one profile of that tab's type, so an "S3" folder created while
   * organizing buckets doesn't show up empty under SSH/SFTP. Turning this on
   * shows every folder in every tab regardless of what it currently contains,
   * for people who deliberately want one shared folder tree across types.
   */
  shareFoldersAcrossTypes?: boolean;
  /** Ephemeral debug container images used for Kubernetes / OpenShift pod debugging. */
  k8sDebugImages?: K8sDebugImage[];
  /** Master switch for the performance bar above SSH / Kubernetes terminals. Off by default; when off nothing is polled. */
  perfMetricsEnabled?: boolean;
  /** How the performance bar is drawn. */
  perfMetricsLayout?: PerfLayout;
  /** Which metrics the bar shows. Ids that don't apply to the session type (e.g. 'load' for a pod) are ignored. */
  perfMetricsItems?: PerfMetricId[];
  /** Polling interval in seconds. Kubernetes sessions are clamped to at least PERF_K8S_MIN_INTERVAL_SEC. */
  perfMetricsIntervalSec?: number;
  /** Enable Git status and Git operations (pull, clone) in file manager/SFTP panes. On by default. */
  fileManagerGitIntegration?: boolean;
  /** SSH Agent integration for local shell terminals. 'auto' = active smartcard agent, else the inherited system/login-shell agent, else an sshs3-managed one ('app-managed' is a legacy alias of 'auto'). */
  localTerminalAgentMode?: 'auto' | 'system' | 'app-managed' | 'disabled';
  /** Keep the sshs3-managed block in ~/.ssh/config in sync with saved SSH profiles. On by default. */
  autoSyncLocalSshConfig?: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  terminalFontSize: 13,
  terminalFontFamily: 'JetBrains Mono, monospace',
  terminalCursorStyle: 'block',
  terminalScrollback: 5000,
  copyOnSelect: false,
  clipboardHistoryScope: 'global',
  clipboardHistoryClearOnExit: false,
  defaultNewTabType: 'terminal',
  confirmBeforeDelete: true,
  showHiddenFiles: false,
  defaultConflictPolicy: 'ask',
  verifyTransferIntegrity: true,
  shortcuts: { ...DEFAULT_SHORTCUTS },
  dotfilesPoolEnabled: false,
  enableOpenShift: false,
  shareFoldersAcrossTypes: false,
  perfMetricsEnabled: false,
  perfMetricsLayout: 'text',
  perfMetricsItems: [...DEFAULT_PERF_ITEMS],
  perfMetricsIntervalSec: 5,
  sessionExitAction: 'reconnect',
  confirmBeforeQuit: false,
  logLevel: 'info',
  autoCheckUpdates: true,
  smartcardAuthMode: 'always-prompt',
  smartcardUnlockAtStartup: false,
  x11ServerMode: 'auto',
  k8sDebugImages: [...DEFAULT_K8S_DEBUG_IMAGES],
  fileManagerGitIntegration: true,
  localTerminalAgentMode: 'auto',
  autoSyncLocalSshConfig: true,
};
