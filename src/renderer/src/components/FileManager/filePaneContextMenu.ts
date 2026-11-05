import {
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  FileCode,
  FilePlus,
  FileJson,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderSync,
  GitBranch,
  GripVertical,
  History,
  Info,
  Link2,
  PackageOpen,
  ListChecks,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  Shield,
  ShieldCheck,
  Tag,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import type { GitRepoStatus } from '@shared/types/git';
import { parentPath } from '../../lib/format';
import { IS_WINDOWS } from '../../lib/platform';
import type { ContextMenuItem } from './ContextMenu';
import type { SourceType } from './types';
import { canCreateFileIn } from './filePaneHelpers';
import { supportsArchives } from './useArchiveActions';
import { detectArchiveKind } from '@shared/archiveNames';
import { isCertificateFileName } from '@shared/certificateFileName';
import type { FileClipboard } from './DragDropContext';
import { toWebRepoUrl } from './filePaneHelpers';

export interface FilePaneContextMenuInput {
  contextMenuOpen: boolean;
  selectedEntries: FileEntry[];
  sourceType: SourceType;
  currentPath: string;
  clipboard: FileClipboard | null;
  gitIntegrationEnabled: boolean;
  gitStatus: GitRepoStatus | null;
  supportsChmod: boolean;
  isBucketEntry: boolean;
  isS3ObjectEntry: boolean;
  selectedAreAllFiles: boolean;
  handleOpen: (entry: FileEntry) => void;
  handleOpenExternal: (entry: FileEntry) => Promise<void> | void;
  handleCut: () => void;
  handleCopy: () => void;
  handlePaste: () => void;
  handleRenameStart: () => void;
  handleDownloadTo: () => Promise<void> | void;
  /** Remote panes only: opens the "Drag out of sshs3" dialog for the selection. */
  handleDragOut?: () => void;
  handleGitPull: () => Promise<void> | void;
  handleDelete: () => Promise<void> | void;
  handleNewFolder: () => Promise<void> | void;
  handleNewFile: () => Promise<void> | void;
  handleCompress: (format: 'tar.gz' | 'zip') => Promise<void> | void;
  handleExtract: () => Promise<void> | void;
  setPatternOpen: (open: boolean) => void;
  handleInvertSelection: () => void;
  load: (force?: boolean) => Promise<void> | void;
  setSyncModalOpen: (open: boolean) => void;
  setEditorTailMode: (tail: boolean) => void;
  setEditorEntry: (entry: FileEntry | null) => void;
  setChmodOpen: (open: boolean) => void;
  setAddToDotfilesOpen: (open: boolean) => void;
  setTagsOpen: (open: boolean) => void;
  setBucketPolicyOpen: (open: boolean) => void;
  setVersionsOpen: (open: boolean) => void;
  setPresignedOpen: (open: boolean) => void;
  setGitCloneTargetDir: (dir: string | null) => void;
  setGitCloneOpen: (open: boolean) => void;
  setPropertiesOpen: (open: boolean) => void;
  setCertificateOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
}

/** The right-click menu: one set of actions for the selection, another for empty space. */
export function buildContextMenuItems(input: FilePaneContextMenuInput): ContextMenuItem[] {
  const {
    contextMenuOpen,
    selectedEntries,
    sourceType,
    currentPath,
    clipboard,
    gitIntegrationEnabled,
    gitStatus,
    supportsChmod,
    isBucketEntry,
    isS3ObjectEntry,
    selectedAreAllFiles,
    handleOpen,
    handleOpenExternal,
    handleCut,
    handleCopy,
    handlePaste,
    handleRenameStart,
    handleDownloadTo,
    handleDragOut,
    handleGitPull,
    handleDelete,
    handleNewFolder,
    handleNewFile,
    handleCompress,
    handleExtract,
    setPatternOpen,
    handleInvertSelection,
    load,
    setSyncModalOpen,
    setEditorTailMode,
    setEditorEntry,
    setChmodOpen,
    setAddToDotfilesOpen,
    setTagsOpen,
    setBucketPolicyOpen,
    setVersionsOpen,
    setPresignedOpen,
    setGitCloneTargetDir,
    setGitCloneOpen,
    setPropertiesOpen,
    setCertificateOpen,
    setSearchOpen,
  } = input;

  return !contextMenuOpen
    ? []
    : selectedEntries.length > 0
      ? [
          ...(selectedEntries.length === 1 && selectedEntries[0].isDirectory
            ? [
                { key: 'open', label: 'Open', icon: FolderOpen, onSelect: () => handleOpen(selectedEntries[0]) },
                {
                  key: 'dirsync',
                  label: 'Sync to...',
                  icon: FolderSync,
                  onSelect: () => setSyncModalOpen(true),
                },
              ]
            : []),
          ...(selectedEntries.length === 1 && !selectedEntries[0].isDirectory
            ? [
                {
                  key: 'edit',
                  label: 'View / Edit...',
                  icon: FileText,
                  onSelect: () => {
                    setEditorTailMode(false);
                    setEditorEntry(selectedEntries[0]);
                  },
                },
                ...(isCertificateFileName(selectedEntries[0].name)
                  ? [
                      {
                        key: 'view-certificate',
                        label: 'View Certificate...',
                        icon: ShieldCheck,
                        onSelect: () => setCertificateOpen(true),
                      },
                    ]
                  : []),
                {
                  key: 'tail',
                  label: 'Tail -f (Stream Log)',
                  icon: Terminal,
                  onSelect: () => {
                    setEditorTailMode(true);
                    setEditorEntry(selectedEntries[0]);
                  },
                },
                {
                  key: 'open-external',
                  label: 'Open in External Editor',
                  icon: ExternalLink,
                  onSelect: () => void handleOpenExternal(selectedEntries[0]),
                },
              ]
            : []),
          {
            key: 'cut',
            label: 'Cut (Ctrl+X)',
            icon: Scissors,
            disabled: selectedEntries.length === 0,
            onSelect: handleCut,
          },
          {
            key: 'copy',
            label: 'Copy (Ctrl+C)',
            icon: Copy,
            disabled: selectedEntries.length === 0,
            onSelect: handleCopy,
          },
          {
            key: 'paste',
            label: 'Paste (Ctrl+V)',
            icon: Clipboard,
            disabled: !clipboard || clipboard.sourcePaths.length === 0,
            onSelect: handlePaste,
          },
          {
            key: 'rename',
            label: 'Rename',
            icon: Pencil,
            disabled: selectedEntries.length !== 1,
            onSelect: handleRenameStart,
          },
          ...(supportsArchives(sourceType)
            ? [
                {
                  key: 'compress-targz',
                  label: 'Compress to .tar.gz',
                  icon: FileArchive,
                  separatorBefore: true,
                  onSelect: () => void handleCompress('tar.gz'),
                },
                { key: 'compress-zip', label: 'Compress to .zip', icon: FileArchive, onSelect: () => void handleCompress('zip') },
                ...(selectedEntries.length === 1 && !selectedEntries[0].isDirectory && detectArchiveKind(selectedEntries[0].name)
                  ? [{ key: 'extract', label: 'Extract to Folder', icon: PackageOpen, onSelect: () => void handleExtract() }]
                  : []),
              ]
            : []),
          {
            key: 'chmod',
            label: IS_WINDOWS && sourceType === 'local' ? 'Change Attributes...' : 'Change Permissions (chmod)...',
            icon: Shield,
            disabled: !supportsChmod,
            onSelect: () => setChmodOpen(true),
          },
          {
            // Renamed from "Copy Path" (UX review #14): the old name was
            // indistinguishable from "Copy File Location" below even
            // though they copy different things (full path vs. containing
            // folder only). Distinct icons help tell the three apart too.
            key: 'copy-path',
            label: 'Copy Full Path',
            icon: Clipboard,
            disabled: selectedEntries.length !== 1,
            onSelect: () => void navigator.clipboard.writeText(selectedEntries[0].path),
          },
          {
            key: 'copy-filename',
            label: 'Copy Filename',
            icon: FileText,
            disabled: selectedEntries.length !== 1,
            onSelect: () => void navigator.clipboard.writeText(selectedEntries[0].name),
          },
          {
            key: 'copy-location',
            label: 'Copy Folder Path',
            icon: FolderOpen,
            disabled: selectedEntries.length !== 1,
            onSelect: () => void navigator.clipboard.writeText(parentPath(selectedEntries[0].path)),
          },
          ...(sourceType !== 'local'
            ? [
                {
                  key: 'download-to',
                  label: 'Download to...',
                  icon: Download,
                  onSelect: () => void handleDownloadTo(),
                },
              ]
            : []),
          ...(handleDragOut
            ? [
                {
                  key: 'drag-out',
                  label: 'Drag out of sshs3...',
                  icon: GripVertical,
                  onSelect: handleDragOut,
                },
              ]
            : []),
          ...(sourceType !== 's3' && selectedEntries.length === 1 && !selectedEntries[0].isDirectory
            ? [
                {
                  key: 'add-to-dotfiles',
                  label: 'Add to Dotfiles Pool...',
                  icon: FileCode,
                  onSelect: () => setAddToDotfilesOpen(true),
                },
              ]
            : []),
          ...(sourceType === 's3'
            ? [
                {
                  key: 'copy-s3-uri',
                  label: 'Copy S3 URI',
                  icon: Clipboard,
                  disabled: selectedEntries.length !== 1,
                  onSelect: () => void navigator.clipboard.writeText(`s3:/${selectedEntries[0].path}`),
                },
                {
                  key: 'tags',
                  label: 'Tags...',
                  icon: Tag,
                  disabled: !(isBucketEntry || isS3ObjectEntry),
                  separatorBefore: true,
                  onSelect: () => setTagsOpen(true),
                },
                {
                  key: 'bucket-policy',
                  label: 'Bucket Policy & CORS...',
                  icon: FileJson,
                  disabled: !isBucketEntry,
                  onSelect: () => setBucketPolicyOpen(true),
                },
                {
                  key: 'versioning',
                  label: isBucketEntry ? 'Bucket Versioning...' : 'Object Versions...',
                  icon: History,
                  disabled: !(isBucketEntry || isS3ObjectEntry),
                  onSelect: () => setVersionsOpen(true),
                },
                {
                  key: 'presigned-url',
                  label: `Generate Web URL${selectedEntries.length > 1 ? 's' : ''}...`,
                  icon: Link2,
                  disabled: !selectedAreAllFiles,
                  onSelect: () => setPresignedOpen(true),
                },
              ]
            : []),
          ...(gitIntegrationEnabled && sourceType !== 's3' && sourceType !== 'k8s'
            ? [
                ...(selectedEntries.length === 1 && selectedEntries[0].isDirectory
                  ? [
                      {
                        key: 'git-clone-into',
                        label: 'Git Clone inside...',
                        icon: GitBranch,
                        separatorBefore: true,
                        onSelect: () => {
                          setGitCloneTargetDir(selectedEntries[0].path);
                          setGitCloneOpen(true);
                        },
                      },
                    ]
                  : []),
                ...(gitStatus?.isRepo
                  ? [
                      {
                        key: 'git-pull',
                        label: 'Git Pull',
                        icon: GitBranch,
                        separatorBefore: selectedEntries.length !== 1 || !selectedEntries[0].isDirectory,
                        onSelect: () => void handleGitPull(),
                      },
                      ...(gitStatus.remoteOriginUrl
                        ? [
                            {
                              key: 'open-git-web',
                              label: 'Open in GitHub/GitLab',
                              icon: ExternalLink,
                              onSelect: () => {
                                const url = toWebRepoUrl(gitStatus.remoteOriginUrl!);
                                if (url) void window.multissh.openExternal(url);
                              },
                            },
                          ]
                        : []),
                    ]
                  : []),
              ]
            : []),
          {
            key: 'properties',
            label: 'Properties',
            icon: Info,
            separatorBefore: sourceType !== 's3',
            onSelect: () => setPropertiesOpen(true),
          },
          {
            key: 'delete',
            label: 'Delete',
            icon: Trash2,
            danger: true,
            separatorBefore: true,
            onSelect: () => void handleDelete(),
          },
        ]
      : [
          { key: 'newfolder', label: 'New Folder', icon: FolderPlus, onSelect: () => void handleNewFolder() },
          ...(canCreateFileIn(sourceType, currentPath)
            ? [{ key: 'newfile', label: 'New File', icon: FilePlus, onSelect: () => void handleNewFile() }]
            : []),
          {
            key: 'paste',
            label: 'Paste (Ctrl+V)',
            icon: Clipboard,
            disabled: !clipboard || clipboard.sourcePaths.length === 0,
            onSelect: handlePaste,
          },
          { key: 'select-pattern', label: 'Select by Pattern... (Ctrl+S)', icon: ListChecks, onSelect: () => setPatternOpen(true) },
          { key: 'invert-selection', label: 'Invert Selection (Ctrl+Shift+A)', icon: ListChecks, onSelect: handleInvertSelection },
          { key: 'refresh', label: 'Refresh', icon: RefreshCw, onSelect: () => void load(true) },
          {
            key: 'search-in-files',
            label: 'Search in Files...',
            icon: Search,
            onSelect: () => setSearchOpen(true),
          },
          ...(gitIntegrationEnabled && sourceType !== 's3' && sourceType !== 'k8s'
            ? [
                {
                  key: 'git-clone',
                  label: 'Git Clone to here...',
                  icon: GitBranch,
                  separatorBefore: true,
                  onSelect: () => {
                    setGitCloneTargetDir(currentPath);
                    setGitCloneOpen(true);
                  },
                },
                ...(gitStatus?.isRepo
                  ? [
                      {
                        key: 'git-pull',
                        label: 'Git Pull',
                        icon: GitBranch,
                        onSelect: () => void handleGitPull(),
                      },
                      ...(gitStatus.remoteOriginUrl
                        ? [
                            {
                              key: 'open-git-web',
                              label: 'Open in GitHub/GitLab',
                              icon: ExternalLink,
                              onSelect: () => {
                                const url = toWebRepoUrl(gitStatus.remoteOriginUrl!);
                                if (url) void window.multissh.openExternal(url);
                              },
                            },
                          ]
                        : []),
                    ]
                  : []),
              ]
            : []),
        ];
}
