import React, { useEffect, useState, useRef } from 'react';
import {
  AlertCircle,
  Bug,
  Cpu,
  Info,
  Layers,
  Loader2,
  Terminal,
  X,
} from 'lucide-react';
import {
  DEFAULT_K8S_DEBUG_IMAGES,
  type K8sDebugImage,
  type K8sTerminalTarget,
} from '@shared/types/kubernetes';
import { describeIpcError } from '../../lib/format';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

export interface K8sDebugModalProps {
  target: {
    contextName: string;
    namespace: string;
    podName: string;
    containers?: string[];
  } | null;
  open: boolean;
  onClose: () => void;
  onAttachSuccess: (target: K8sTerminalTarget) => void;
}

export const K8sDebugModal: React.FC<K8sDebugModalProps> = ({
  target,
  open,
  onClose,
  onAttachSuccess,
}) => {
  const [debugImages, setDebugImages] = useState<K8sDebugImage[]>(DEFAULT_K8S_DEBUG_IMAGES);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('netshoot');
  const [image, setImage] = useState<string>('nicolaka/netshoot');
  const [targetContainer, setTargetContainer] = useState<string>('');
  const [containerName, setContainerName] = useState<string>('');
  const [command, setCommand] = useState<string>('bash');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Load configured debug images from settings
  useEffect(() => {
    if (!open) return;
    window.multissh
      .settingsGet()
      .then((settings) => {
        if (settings.k8sDebugImages && settings.k8sDebugImages.length > 0) {
          setDebugImages(settings.k8sDebugImages);
          // If current preset not in loaded list, default to first
          setSelectedPresetId((currentId) => {
            const found = settings.k8sDebugImages!.find((img) => img.id === currentId);
            if (!found && settings.k8sDebugImages!.length > 0) {
              const first = settings.k8sDebugImages![0];
              setImage(first.image);
              setCommand(first.defaultCommand || 'bash');
              return first.id;
            }
            return currentId;
          });
        }
      })
      .catch(() => {});
  }, [open]);

  // Reset fields when target changes or modal opens
  useEffect(() => {
    if (open && target) {
      setError(null);
      setSubmitting(false);
      const randSuffix = Math.random().toString(36).substring(2, 7);
      setContainerName(`debugger-${randSuffix}`);
      if (target.containers && target.containers.length > 0) {
        setTargetContainer(target.containers[0]);
      } else {
        setTargetContainer('');
      }
    }
  }, [open, target]);

  // Escape closes; a stray backdrop click would discard typed input, so it is intentionally ignored.
  useModalDismiss(onClose, open && !!target);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open && !!target);
  if (!open || !target) return null;

  const handlePresetChange = (presetId: string) => {
    setSelectedPresetId(presetId);
    if (presetId === 'custom') {
      return;
    }
    const preset = debugImages.find((img) => img.id === presetId);
    if (preset) {
      setImage(preset.image);
      setCommand(preset.defaultCommand || 'bash');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!image.trim()) {
      setError('Container image is required.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await window.multissh.k8sAttachDebugContainer({
        contextName: target.contextName,
        namespace: target.namespace,
        podName: target.podName,
        image: image.trim(),
        containerName: containerName.trim() || undefined,
        targetContainerName: targetContainer.trim() || undefined,
        command: command.trim() ? [command.trim()] : undefined,
      });

      onAttachSuccess({
        contextName: target.contextName,
        namespace: target.namespace,
        podName: target.podName,
        containerName: res.containerName,
        shell: command.trim() || '/bin/sh',
      });
      onClose();
    } catch (err: any) {
      setError(describeIpcError(err, String(err)));
      setSubmitting(false);
    }
  };

  const selectedPreset = debugImages.find((p) => p.id === selectedPresetId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Attach debug container" className="flex w-full max-w-xl flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-divider bg-app-surface px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
              <Bug className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-txt-primary">Attach Debug Container</h2>
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5 text-xs text-txt-secondary">
          {/* Target pod summary banner */}
          <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-app-surface p-3">
            <div className="min-w-0">
              <div className="text-xs text-txt-muted">Target Pod</div>
              <div className="truncate font-semibold text-txt-primary text-sm">{target.podName}</div>
              <div className="truncate text-xs text-txt-muted">
                Namespace: <span className="font-mono text-txt-secondary">{target.namespace}</span> · Cluster:{' '}
                <span className="font-mono text-txt-secondary">{target.contextName}</span>
              </div>
            </div>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-400">
              <Cpu className="h-5 w-5" />
            </div>
          </div>

          {/* Preset image selector */}
          <div className="space-y-1.5">
            <label htmlFor="k8s-debug-preset" className="font-medium text-txt-primary flex items-center justify-between">
              <span>Debug Toolset / Image Preset</span>
              <span className="text-xs font-normal text-txt-muted">Configurable in Settings</span>
            </label>
            <select
              id="k8s-debug-preset"
              value={selectedPresetId}
              onChange={(e) => handlePresetChange(e.target.value)}
              disabled={submitting}
              className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs text-txt-primary focus:border-amber-500 focus:outline-none disabled:opacity-50"
            >
              {debugImages.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} ({preset.image})
                </option>
              ))}
              <option value="custom">Custom Image...</option>
            </select>
            {selectedPreset?.description && (
              <p className="text-xs text-txt-muted">{selectedPreset.description}</p>
            )}
          </div>

          {/* Image input */}
          <div className="space-y-1.5">
            <label className="font-medium text-txt-primary flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-txt-muted" />
              <span>Container Image</span>
            </label>
            <input
              aria-label="Container image"
              type="text"
              value={image}
              onChange={(e) => {
                setImage(e.target.value);
                if (selectedPresetId !== 'custom') {
                  const match = debugImages.find((p) => p.image === e.target.value);
                  setSelectedPresetId(match ? match.id : 'custom');
                }
              }}
              disabled={submitting}
              placeholder="e.g. nicolaka/netshoot:latest"
              className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 font-mono text-xs text-txt-primary focus:border-amber-500 focus:outline-none disabled:opacity-50"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Target Container for Process Namespace Sharing */}
            <div className="space-y-1.5">
              <label htmlFor="k8s-debug-target-container" className="font-medium text-txt-primary flex items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 text-txt-muted" />
                <span>Target Container (PID Sharing)</span>
              </label>
              <select
                id="k8s-debug-target-container"
                value={targetContainer}
                onChange={(e) => setTargetContainer(e.target.value)}
                disabled={submitting}
                className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs text-txt-primary focus:border-amber-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">None (Entire Pod)</option>
                {target.containers?.map((cName) => (
                  <option key={cName} value={cName}>
                    {cName}
                  </option>
                ))}
              </select>
              <p className="text-2xs text-txt-muted">
                Shares process & IPC namespace with the selected container.
              </p>
            </div>

            {/* Shell / Entry Command */}
            <div className="space-y-1.5">
              <label className="font-medium text-txt-primary flex items-center gap-1.5">
                <Terminal className="h-3.5 w-3.5 text-txt-muted" />
                <span>Interactive Shell</span>
              </label>
              <input
                aria-label="Shell command"
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                disabled={submitting}
                placeholder="e.g. bash or sh"
                className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 font-mono text-xs text-txt-primary focus:border-amber-500 focus:outline-none disabled:opacity-50"
              />
              <p className="text-2xs text-txt-muted">Default command to start interactive session.</p>
            </div>
          </div>

          {/* Ephemeral Container Name */}
          <div className="space-y-1.5">
            <label className="font-medium text-txt-primary">Ephemeral Container Name</label>
            <input
              aria-label="Ephemeral container name"
              type="text"
              value={containerName}
              onChange={(e) => setContainerName(e.target.value)}
              disabled={submitting}
              placeholder="e.g. debugger-xyz123"
              className="w-full rounded-lg border border-border-subtle bg-app-surface px-3 py-2 font-mono text-xs text-txt-primary focus:border-amber-500 focus:outline-none disabled:opacity-50"
            />
          </div>

          {/* Info note */}
          <div className="flex items-start gap-2 rounded-lg bg-sky-500/10 border border-sky-500/20 p-2.5 text-xs text-sky-300">
            <Info className="h-4 w-4 shrink-0 text-sky-400 mt-0.5" />
            <div className="space-y-0.5">
              <p className="font-medium">Live debugging via Ephemeral Containers (kubectl debug)</p>
              <p className="text-txt-muted">
                Injected directly into the running pod without restart. Once started, SSHS3 automatically
                opens an interactive terminal session inside this debug container.
              </p>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
              <div className="min-w-0 flex-1 break-words">{error}</div>
            </div>
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-between pt-2 border-t border-divider">
            <div className="text-xs text-txt-muted">
              {submitting ? (
                <span className="flex items-center gap-1.5 text-amber-400 font-medium">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating container & pulling image...
                </span>
              ) : (
                'Container starts immediately on attach'
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 shadow-sm transition-colors disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Bug className="h-3.5 w-3.5" />
                )}
                <span>{submitting ? 'Attaching...' : 'Attach Debugger'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
