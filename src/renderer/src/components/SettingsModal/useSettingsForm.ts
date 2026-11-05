import type { LogLevel } from '@shared/types/log';
import React, { useState, useEffect, useRef } from 'react';
import { useUpdateState } from '../../lib/useUpdateState';
import { DEFAULT_PERF_ITEMS, type PerfLayout, type PerfMetricId } from '@shared/types/perf';
import { SHORTCUT_DEFINITIONS, DEFAULT_SHORTCUTS, type AppSettings, type AppTheme, type SessionExitAction, type SmartcardAuthMode } from '@shared/types/settings';
import type { SshCaConfig } from '@shared/types/sshCa';
import { DEFAULT_K8S_DEBUG_IMAGES, type K8sDebugImage } from '@shared/types/kubernetes';
import type { DetectedSmartcardLib, XServerStatus } from '@shared/types/ssh';
import type { PolicyInfo, PolicySettingId } from '@shared/types/policy';
import { comboFromKeyboardEvent, modifierPreviewFromKeyboardEvent } from '../../lib/shortcuts';
import { validateCustomPortRegex } from '../../lib/portDetection';
import { type SettingsCategory, normalizeAgentMode } from './settingsConstants';

interface UseSettingsFormArgs {
  open: boolean;
  /** Category shown when the dialog opens; defaults to General. */
  initialCategory?: SettingsCategory;
  currentSettings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClose: () => void;
}

/** All editable settings as draft state, the data they load on open, and the handlers the panels share. */
export function useSettingsForm({ open, initialCategory, currentSettings, onSave, onClose }: UseSettingsFormArgs) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('general');
  const [theme, setTheme] = useState<AppTheme>(currentSettings.theme);
  const [fontSize, setFontSize] = useState<number>(currentSettings.terminalFontSize);
  const [fontFamily, setFontFamily] = useState<string>(currentSettings.terminalFontFamily);
  const [cursorStyle, setCursorStyle] = useState<'block' | 'underline' | 'bar'>(
    currentSettings.terminalCursorStyle ?? 'block'
  );
  const [scrollback, setScrollback] = useState<number>(
    currentSettings.terminalScrollback ?? 5000
  );
  const [terminalPathHoverPreview, setTerminalPathHoverPreview] = useState<boolean>(
    currentSettings.terminalPathHoverPreview ?? true
  );
  const [terminalPathHoverMode, setTerminalPathHoverMode] = useState<'hover' | 'ctrl'>(
    currentSettings.terminalPathHoverMode ?? 'hover'
  );
  const [terminalSudoRetryPrompt, setTerminalSudoRetryPrompt] = useState<boolean>(
    currentSettings.terminalSudoRetryPrompt ?? true
  );
  const [terminalPortForwardAutoDetect, setTerminalPortForwardAutoDetect] = useState<boolean>(
    currentSettings.terminalPortForwardAutoDetect ?? true
  );
  const [terminalPortForwardCustomRegex, setTerminalPortForwardCustomRegex] = useState<string>(
    currentSettings.terminalPortForwardCustomRegex ?? ''
  );
  const [copyOnSelect, setCopyOnSelect] = useState<boolean>(
    currentSettings.copyOnSelect ?? false
  );
  const [clipboardScope, setClipboardScope] = useState<'global' | 'host'>(
    currentSettings.clipboardHistoryScope ?? 'global'
  );
  const [clipboardClearOnExit, setClipboardClearOnExit] = useState<boolean>(
    currentSettings.clipboardHistoryClearOnExit ?? false
  );
  const [perfEnabled, setPerfEnabled] = useState<boolean>(currentSettings.perfMetricsEnabled ?? false);
  const [perfLayout, setPerfLayout] = useState<PerfLayout>(currentSettings.perfMetricsLayout ?? 'text');
  const [perfItems, setPerfItems] = useState<PerfMetricId[]>(currentSettings.perfMetricsItems ?? DEFAULT_PERF_ITEMS);
  const [perfIntervalSec, setPerfIntervalSec] = useState<number>(currentSettings.perfMetricsIntervalSec ?? 5);
  const [sessionExitAction, setSessionExitAction] = useState<SessionExitAction>(
    currentSettings.sessionExitAction ?? 'reconnect'
  );
  const updateState = useUpdateState();
  const [policy, setPolicy] = useState<PolicyInfo | null>(null);
  const [autoCheckUpdates, setAutoCheckUpdates] = useState<boolean>(currentSettings.autoCheckUpdates ?? true);
  const [confirmBeforeQuit, setConfirmBeforeQuit] = useState<boolean>(
    currentSettings.confirmBeforeQuit ?? false
  );
  const [enableGlobalSearch, setEnableGlobalSearch] = useState<boolean>(currentSettings.enableGlobalSearch ?? true);
  const [logLevel, setLogLevel] = useState<LogLevel>(currentSettings.logLevel ?? 'info');
  const [defaultNewTab, setDefaultNewTab] = useState<'terminal' | 'filemanager'>(
    currentSettings.defaultNewTabType
  );
  const [defaultConflictPolicy, setDefaultConflictPolicy] = useState<
    'ask' | 'overwrite' | 'skip' | 'rename'
  >(currentSettings.defaultConflictPolicy ?? 'ask');
  const [showHiddenFiles, setShowHiddenFiles] = useState<boolean>(
    currentSettings.showHiddenFiles ?? false
  );
  const [verifyTransferIntegrity, setVerifyTransferIntegrity] = useState<boolean>(
    currentSettings.verifyTransferIntegrity ?? true
  );
  const [shareFoldersAcrossTypes, setShareFoldersAcrossTypes] = useState<boolean>(
    currentSettings.shareFoldersAcrossTypes ?? false
  );
  const [confirmBeforeDelete, setConfirmBeforeDelete] = useState<boolean>(
    currentSettings.confirmBeforeDelete ?? true
  );
  const [dotfilesPoolEnabled, setDotfilesPoolEnabled] = useState<boolean>(
    currentSettings.dotfilesPoolEnabled ?? false
  );
  const [smartcardAuthMode, setSmartcardAuthMode] = useState<SmartcardAuthMode>(
    currentSettings.smartcardAuthMode ?? 'always-prompt'
  );
  const [smartcardUnlockAtStartup, setSmartcardUnlockAtStartup] = useState<boolean>(
    currentSettings.smartcardUnlockAtStartup ?? false
  );
  const [smartcardLibPath, setSmartcardLibPath] = useState<string>(currentSettings.smartcardLibPath ?? '');
  const [fileManagerGitIntegration, setFileManagerGitIntegration] = useState<boolean>(
    currentSettings.fileManagerGitIntegration ?? true
  );
  const [autoSyncLocalSshConfig, setAutoSyncLocalSshConfig] = useState<boolean>(
    currentSettings.autoSyncLocalSshConfig ?? true
  );
  const [localTerminalAgentMode, setLocalTerminalAgentMode] = useState<'auto' | 'system' | 'app-managed' | 'disabled'>(
    normalizeAgentMode(currentSettings.localTerminalAgentMode)
  );
  const [poolManagerOpen, setPoolManagerOpen] = useState(false);

  const [shortcuts, setShortcuts] = useState<Record<string, string>>(() => ({
    ...DEFAULT_SHORTCUTS,
    ...(currentSettings.shortcuts ?? {}),
  }));
  const [recordingAction, setRecordingAction] = useState<string | null>(null);
  const [recordingPreview, setRecordingPreview] = useState<string | null>(null);
  const [shortcutSearch, setShortcutSearch] = useState('');

  const [smartcardLibs, setSmartcardLibs] = useState<DetectedSmartcardLib[]>([]);
  const [detectingSmartcard, setDetectingSmartcard] = useState(false);
  const [sshCaConfigs, setSshCaConfigs] = useState<SshCaConfig[]>(currentSettings.sshCaConfigs ?? []);
  const [defaultSshCaConfigId, setDefaultSshCaConfigId] = useState<string | undefined>(currentSettings.defaultSshCaConfigId);

  const [x11ServerMode, setX11ServerMode] = useState<'auto' | 'manual' | 'always'>(
    currentSettings.x11ServerMode ?? 'auto'
  );
  const [x11ServerPath, setX11ServerPath] = useState<string>(
    currentSettings.x11ServerPath ?? ''
  );
  const [x11ServerArgs, setX11ServerArgs] = useState<string>(
    currentSettings.x11ServerArgs ?? ''
  );
  const [x11Status, setX11Status] = useState<XServerStatus | null>(null);
  const [x11Operating, setX11Operating] = useState<boolean>(false);
  const [platform, setPlatform] = useState<string>('');

  const [enableOpenShift, setEnableOpenShift] = useState<boolean>(
    currentSettings.enableOpenShift ?? false
  );
  const [k8sDebugImages, setK8sDebugImages] = useState<K8sDebugImage[]>(
    currentSettings.k8sDebugImages ?? [...DEFAULT_K8S_DEBUG_IMAGES]
  );
  const [showAddDebugImage, setShowAddDebugImage] = useState(false);
  const [newImageName, setNewImageName] = useState('');
  const [newImageRef, setNewImageRef] = useState('');
  const [newImageCmd, setNewImageCmd] = useState('');
  const [newImageDesc, setNewImageDesc] = useState('');

  const isLinux = (x11Status?.platform || platform) === 'linux';

  // null while unknown (still loading) - only "false" should ever trigger the warning card.
  const [credentialEncryptionAvailable, setCredentialEncryptionAvailable] = useState<boolean | null>(null);

  // Which settings an administrator's policy locks (read each time the dialog opens; policy changes need a restart anyway).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.multissh
      ?.policyGet?.()
      .then((info) => {
        if (!cancelled) setPolicy(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);
  const isManaged = (id: PolicySettingId): boolean => policy?.managed.includes(id) ?? false;
  const policyWarnings = policy?.warnings ?? [];

  // Re-seed the draft only when the dialog opens. An external settings change while it is open
  // (e.g. the font-size shortcuts) must not throw away what the user has edited.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (justOpened) {
      setActiveCategory(initialCategory ?? 'general');
      setTheme(currentSettings.theme);
      setFontSize(currentSettings.terminalFontSize);
      setFontFamily(currentSettings.terminalFontFamily);
      setCursorStyle(currentSettings.terminalCursorStyle ?? 'block');
      setScrollback(currentSettings.terminalScrollback ?? 5000);
      setTerminalPathHoverPreview(currentSettings.terminalPathHoverPreview ?? true);
      setTerminalPathHoverMode(currentSettings.terminalPathHoverMode ?? 'hover');
      setTerminalSudoRetryPrompt(currentSettings.terminalSudoRetryPrompt ?? true);
      setTerminalPortForwardAutoDetect(currentSettings.terminalPortForwardAutoDetect ?? true);
      setTerminalPortForwardCustomRegex(currentSettings.terminalPortForwardCustomRegex ?? '');
      setCopyOnSelect(currentSettings.copyOnSelect ?? false);
      setClipboardScope(currentSettings.clipboardHistoryScope ?? 'global');
      setClipboardClearOnExit(currentSettings.clipboardHistoryClearOnExit ?? false);
      setPerfEnabled(currentSettings.perfMetricsEnabled ?? false);
      setPerfLayout(currentSettings.perfMetricsLayout ?? 'text');
      setPerfItems(currentSettings.perfMetricsItems ?? DEFAULT_PERF_ITEMS);
      setPerfIntervalSec(currentSettings.perfMetricsIntervalSec ?? 5);
      setSessionExitAction(currentSettings.sessionExitAction ?? 'reconnect');
      setConfirmBeforeQuit(currentSettings.confirmBeforeQuit ?? false);
      setEnableGlobalSearch(currentSettings.enableGlobalSearch ?? true);
      setLogLevel(currentSettings.logLevel ?? 'info');
      setAutoCheckUpdates(currentSettings.autoCheckUpdates ?? true);
      setDefaultNewTab(currentSettings.defaultNewTabType);
      setDefaultConflictPolicy(currentSettings.defaultConflictPolicy ?? 'ask');
      setShowHiddenFiles(currentSettings.showHiddenFiles ?? false);
      setVerifyTransferIntegrity(currentSettings.verifyTransferIntegrity ?? true);
      setShareFoldersAcrossTypes(currentSettings.shareFoldersAcrossTypes ?? false);
      setConfirmBeforeDelete(currentSettings.confirmBeforeDelete ?? true);
      setDotfilesPoolEnabled(currentSettings.dotfilesPoolEnabled ?? false);
      setSmartcardAuthMode(currentSettings.smartcardAuthMode ?? 'always-prompt');
      setSmartcardUnlockAtStartup(currentSettings.smartcardUnlockAtStartup ?? false);
      setSmartcardLibPath(currentSettings.smartcardLibPath ?? '');
      setFileManagerGitIntegration(currentSettings.fileManagerGitIntegration ?? true);
      setLocalTerminalAgentMode(normalizeAgentMode(currentSettings.localTerminalAgentMode));
      setAutoSyncLocalSshConfig(currentSettings.autoSyncLocalSshConfig ?? true);
      setX11ServerMode(currentSettings.x11ServerMode ?? 'auto');
      setX11ServerPath(currentSettings.x11ServerPath ?? '');
      setX11ServerArgs(currentSettings.x11ServerArgs ?? '');
      setShortcuts({
        ...DEFAULT_SHORTCUTS,
        ...(currentSettings.shortcuts ?? {}),
      });
      setRecordingAction(null);
      setShortcutSearch('');
      setEnableOpenShift(currentSettings.enableOpenShift ?? false);
      setK8sDebugImages(currentSettings.k8sDebugImages ?? [...DEFAULT_K8S_DEBUG_IMAGES]);
      setShowAddDebugImage(false);
      setSshCaConfigs(currentSettings.sshCaConfigs ?? []);
      setDefaultSshCaConfigId(currentSettings.defaultSshCaConfigId);

      // Auto detect smartcards for security tab
      setDetectingSmartcard(true);
      void window.multissh
        ?.smartcardDetect?.()
        ?.then((libs) => {
          if (libs) setSmartcardLibs(libs.filter((l) => l.exists));
        })
        ?.finally(() => setDetectingSmartcard(false));

      void window.multissh
        ?.x11GetStatus?.(currentSettings.x11ServerPath)
        ?.then((status) => {
          if (status) setX11Status(status);
        });

      setCredentialEncryptionAvailable(null);
      void window.multissh
        ?.getSecurityStatus?.()
        ?.then((status) => {
          if (status) setCredentialEncryptionAvailable(status.credentialEncryptionAvailable);
        })
        ?.catch(() => {
          // Unknown is safer than falsely claiming "Active" - leave it null.
        });

      void window.multissh
        ?.getPlatform?.()
        ?.then((p) => {
          if (p) setPlatform(p);
        });
    }
  }, [open, initialCategory, currentSettings]);

  const refreshX11Status = async (customPath?: string) => {
    try {
      const status = await window.multissh?.x11GetStatus?.(customPath !== undefined ? customPath : x11ServerPath);
      if (status) setX11Status(status);
    } catch {
      // ignore
    }
  };

  const handleStartX11 = async () => {
    setX11Operating(true);
    try {
      await window.multissh?.x11StartServer?.({
        customPath: x11ServerPath || undefined,
        customArgs: x11ServerArgs || undefined,
      });
      await refreshX11Status();
    } finally {
      setX11Operating(false);
    }
  };

  const handleStopX11 = async () => {
    setX11Operating(true);
    try {
      await window.multissh?.x11StopServer?.();
      await refreshX11Status();
    } finally {
      setX11Operating(false);
    }
  };

  const handleBrowseX11Path = async () => {
    try {
      const file = await window.multissh?.dialogOpenFile?.({
        title: 'Select X Server Executable (vcxsrv.exe, xming.exe)',
        filters: [{ name: 'Executable', extensions: ['exe'] }],
      });
      if (file) {
        setX11ServerPath(file);
        void refreshX11Status(file);
      }
    } catch {
      // ignore
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      theme,
      terminalFontSize: fontSize,
      terminalFontFamily: fontFamily,
      terminalCursorStyle: cursorStyle,
      terminalScrollback: scrollback,
      terminalPathHoverPreview,
      terminalPathHoverMode,
      terminalSudoRetryPrompt,
      terminalPortForwardAutoDetect,
      terminalPortForwardCustomRegex: validateCustomPortRegex(terminalPortForwardCustomRegex).valid
        ? terminalPortForwardCustomRegex.trim()
        : '',
      copyOnSelect,
      clipboardHistoryScope: clipboardScope,
      clipboardHistoryClearOnExit: clipboardClearOnExit,
      perfMetricsEnabled: perfEnabled,
      perfMetricsLayout: perfLayout,
      perfMetricsItems: perfItems,
      perfMetricsIntervalSec: perfIntervalSec,
      sessionExitAction,
      confirmBeforeQuit,
      enableGlobalSearch,
      logLevel,
      autoCheckUpdates,
      defaultNewTabType: defaultNewTab,
      defaultConflictPolicy,
      showHiddenFiles,
      verifyTransferIntegrity,
      shareFoldersAcrossTypes,
      confirmBeforeDelete,
      dotfilesPoolEnabled,
      smartcardAuthMode,
      smartcardUnlockAtStartup,
      smartcardLibPath: smartcardLibPath || undefined,
      fileManagerGitIntegration,
      localTerminalAgentMode,
      autoSyncLocalSshConfig,
      x11ServerMode,
      x11ServerPath,
      x11ServerArgs,
      shortcuts,
      enableOpenShift,
      k8sDebugImages,
      sshCaConfigs,
      defaultSshCaConfigId,
      // Not edited anywhere in this form (set via the Team Vault detail panel's own toggle/pin
      // instead) — passed through unchanged so this full-object onSave doesn't silently drop
      // them from in-memory App state. See SettingsStore.setTeamVaultTabVisible's doc comment
      // for why the detail panel writes connectionManagerVisibleTeamVaults atomically rather
      // than through this same submit path.
      connectionManagerVisibleTeamVaults: currentSettings.connectionManagerVisibleTeamVaults,
      connectionManagerDefaultTab: currentSettings.connectionManagerDefaultTab,
    });
    onClose();
  };

  const handleResetShortcuts = () => {
    setShortcuts({ ...DEFAULT_SHORTCUTS });
  };

  const handleKeyDownRecord = (e: React.KeyboardEvent, actionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecordingAction(null);
      setRecordingPreview(null);
      return;
    }
    // Shares its combo-building logic with the runtime shortcut matcher in App.tsx: a shortcut
    // recorded here for a given physical key must resolve to the exact same string that pressing
    // that key produces at runtime, or the saved binding silently never fires.
    const combo = comboFromKeyboardEvent(e);
    if (combo === null) {
      // A lone modifier (or a dead-key/compose event with no `key`) isn't a complete combo yet —
      // show it as a live preview so the recorder doesn't look unresponsive while it's held.
      setRecordingPreview(modifierPreviewFromKeyboardEvent(e));
      return;
    }
    setShortcuts((prev) => ({ ...prev, [actionId]: combo }));
    setRecordingAction(null);
    setRecordingPreview(null);
  };

  const handleKeyUpRecord = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      setRecordingPreview(null);
    }
  };

  const filteredShortcuts = SHORTCUT_DEFINITIONS.filter(
    (s) =>
      !shortcutSearch ||
      s.name.toLowerCase().includes(shortcutSearch.toLowerCase()) ||
      s.category.toLowerCase().includes(shortcutSearch.toLowerCase()) ||
      s.defaultKeys.toLowerCase().includes(shortcutSearch.toLowerCase())
  );

  return {
    activeCategory,
    setActiveCategory,
    theme,
    setTheme,
    fontSize,
    setFontSize,
    fontFamily,
    setFontFamily,
    cursorStyle,
    setCursorStyle,
    scrollback,
    setScrollback,
    terminalPathHoverPreview,
    setTerminalPathHoverPreview,
    terminalPathHoverMode,
    setTerminalPathHoverMode,
    terminalSudoRetryPrompt,
    setTerminalSudoRetryPrompt,
    terminalPortForwardAutoDetect,
    setTerminalPortForwardAutoDetect,
    terminalPortForwardCustomRegex,
    setTerminalPortForwardCustomRegex,
    copyOnSelect,
    setCopyOnSelect,
    clipboardScope,
    setClipboardScope,
    clipboardClearOnExit,
    setClipboardClearOnExit,
    perfEnabled,
    setPerfEnabled,
    perfLayout,
    setPerfLayout,
    perfItems,
    setPerfItems,
    perfIntervalSec,
    setPerfIntervalSec,
    sessionExitAction,
    setSessionExitAction,
    autoCheckUpdates,
    setAutoCheckUpdates,
    confirmBeforeQuit,
    setConfirmBeforeQuit,
    enableGlobalSearch,
    setEnableGlobalSearch,
    logLevel,
    setLogLevel,
    defaultNewTab,
    setDefaultNewTab,
    defaultConflictPolicy,
    setDefaultConflictPolicy,
    showHiddenFiles,
    setShowHiddenFiles,
    verifyTransferIntegrity,
    setVerifyTransferIntegrity,
    shareFoldersAcrossTypes,
    setShareFoldersAcrossTypes,
    confirmBeforeDelete,
    setConfirmBeforeDelete,
    dotfilesPoolEnabled,
    setDotfilesPoolEnabled,
    smartcardAuthMode,
    setSmartcardAuthMode,
    smartcardUnlockAtStartup,
    setSmartcardUnlockAtStartup,
    smartcardLibPath,
    setSmartcardLibPath,
    fileManagerGitIntegration,
    setFileManagerGitIntegration,
    autoSyncLocalSshConfig,
    setAutoSyncLocalSshConfig,
    localTerminalAgentMode,
    setLocalTerminalAgentMode,
    poolManagerOpen,
    setPoolManagerOpen,
    shortcuts,
    setShortcuts,
    recordingAction,
    setRecordingAction,
    recordingPreview,
    handleKeyUpRecord,
    shortcutSearch,
    setShortcutSearch,
    smartcardLibs,
    setSmartcardLibs,
    detectingSmartcard,
    setDetectingSmartcard,
    sshCaConfigs,
    setSshCaConfigs,
    defaultSshCaConfigId,
    setDefaultSshCaConfigId,
    x11ServerMode,
    setX11ServerMode,
    x11ServerPath,
    setX11ServerPath,
    x11ServerArgs,
    setX11ServerArgs,
    x11Status,
    setX11Status,
    x11Operating,
    setX11Operating,
    platform,
    setPlatform,
    enableOpenShift,
    setEnableOpenShift,
    k8sDebugImages,
    setK8sDebugImages,
    showAddDebugImage,
    setShowAddDebugImage,
    newImageName,
    setNewImageName,
    newImageRef,
    setNewImageRef,
    newImageCmd,
    setNewImageCmd,
    newImageDesc,
    setNewImageDesc,
    credentialEncryptionAvailable,
    setCredentialEncryptionAvailable,
    updateState,
    isManaged,
    policyWarnings,
    isLinux,
    refreshX11Status,
    handleStartX11,
    handleStopX11,
    handleBrowseX11Path,
    handleSubmit,
    handleResetShortcuts,
    handleKeyDownRecord,
    filteredShortcuts,
  };
}

export type SettingsForm = ReturnType<typeof useSettingsForm>;
