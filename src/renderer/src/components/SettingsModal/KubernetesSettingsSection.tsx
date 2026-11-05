import React from 'react';
import { RotateCcw, Plus, Trash2 } from 'lucide-react';
import { DEFAULT_K8S_DEBUG_IMAGES, type K8sDebugImage } from '@shared/types/kubernetes';
import type { SettingsForm } from './useSettingsForm';
import { ManagedGroup } from './Managed';

/** The "Kubernetes & Debug" page of the settings dialog. */
export const KubernetesSettingsSection: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const {
    enableOpenShift,
    setEnableOpenShift,
    isManaged,
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
  } = form;

  const addImage = () => {
    if (!newImageName.trim() || !newImageRef.trim()) return;
    const newEntry: K8sDebugImage = {
      id: `custom-${Date.now()}`,
      name: newImageName.trim(),
      image: newImageRef.trim(),
      defaultCommand: newImageCmd.trim() || 'sh',
      description: newImageDesc.trim() || undefined,
    };
    setK8sDebugImages((prev) => [...prev, newEntry]);
    setShowAddDebugImage(false);
    setNewImageName('');
    setNewImageRef('');
    setNewImageCmd('');
    setNewImageDesc('');
  };

  return (
    <div className="space-y-6">
      {/* OpenShift Support Toggle */}
      <div className="rounded-xl border border-border-subtle bg-app-surface p-4 space-y-2">
        <ManagedGroup managed={isManaged('enableOpenShift')} indentNotice>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={enableOpenShift}
              onChange={(e) => setEnableOpenShift(e.target.checked)}
              className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
            />
            <span className="text-xs font-semibold text-txt-primary">
              Enable OpenShift Support
            </span>
          </label>
        </ManagedGroup>
        <p className="pl-6 text-xs text-txt-muted leading-relaxed">
          Enables OpenShift-specific capabilities, such as the OpenShift Login dialog (token-based <code>oc login</code>) in the Kubernetes connection tree and the local <code>oc</code> CLI shim in terminal sessions.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold text-txt-primary">Kubernetes & OpenShift Debug Images</h3>
            <p className="text-xs text-txt-muted mt-0.5">
              Pre-configured container images used when attaching an ephemeral debug container (<code>kubectl debug</code>) into a running pod.
            </p>
          </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setK8sDebugImages([...DEFAULT_K8S_DEBUG_IMAGES])}
            className="flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <RotateCcw className="h-3.5 w-3.5 text-txt-muted" />
            Reset
          </button>
          <button
            type="button"
            onClick={() => setShowAddDebugImage((prev) => !prev)}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 transition-colors shadow-sm"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Image
          </button>
        </div>
      </div>

      {/* Add New Image Form Card */}
      {showAddDebugImage && (
        <div
          className="rounded-xl border border-sky-500/30 bg-app-surface p-4 space-y-3"
          onKeyDown={(e) => {
            // These fields sit inside the Settings <form>: Enter would submit it (saving and closing Settings and
            // losing the image). Enter in a field adds the image instead.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement) {
              e.preventDefault();
              addImage();
            }
          }}
        >
          <div className="font-semibold text-xs text-txt-primary">Add Custom Debug Image</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-txt-secondary">Display Name *</label>
              <input
                aria-label="Display name"
                type="text"
                value={newImageName}
                onChange={(e) => setNewImageName(e.target.value)}
                placeholder="e.g. Alpine Linux"
                className="w-full rounded-lg border border-border-subtle bg-app-card px-2.5 py-1.5 text-xs text-txt-primary focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-txt-secondary">Image Reference *</label>
              <input
                aria-label="Image reference"
                type="text"
                value={newImageRef}
                onChange={(e) => setNewImageRef(e.target.value)}
                placeholder="e.g. alpine:latest"
                className="w-full rounded-lg border border-border-subtle bg-app-card px-2.5 py-1.5 font-mono text-xs text-txt-primary focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1 sm:col-span-1">
              <label className="text-xs font-medium text-txt-secondary">Default Shell / Command</label>
              <input
                aria-label="Default shell / command"
                type="text"
                value={newImageCmd}
                onChange={(e) => setNewImageCmd(e.target.value)}
                placeholder="e.g. sh or bash"
                className="w-full rounded-lg border border-border-subtle bg-app-card px-2.5 py-1.5 font-mono text-xs text-txt-primary focus:border-sky-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-txt-secondary">Description</label>
              <input
                aria-label="Description"
                type="text"
                value={newImageDesc}
                onChange={(e) => setNewImageDesc(e.target.value)}
                placeholder="e.g. Lightweight shell with apk package manager"
                className="w-full rounded-lg border border-border-subtle bg-app-card px-2.5 py-1.5 text-xs text-txt-primary focus:border-sky-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setShowAddDebugImage(false);
                setNewImageName('');
                setNewImageRef('');
                setNewImageCmd('');
                setNewImageDesc('');
              }}
              className="rounded-lg border border-border-subtle px-3 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={addImage}
              disabled={!newImageName.trim() || !newImageRef.trim()}
              className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 transition-colors shadow-sm"
            >
              Save Image
            </button>
          </div>
        </div>
      )}

      {/* List of Configured Debug Images */}
      <div className="space-y-2.5">
        {k8sDebugImages.map((img) => (
          <div
            key={img.id}
            className="flex items-start justify-between gap-3 rounded-xl border border-border-subtle bg-app-surface p-3 transition-colors hover:border-sky-500/30"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-txt-primary text-xs">{img.name}</span>
                {img.defaultCommand && (
                  <span className="rounded bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.2 font-mono text-2xs text-sky-400">
                    {img.defaultCommand}
                  </span>
                )}
              </div>
              <div className="font-mono text-xs text-txt-secondary break-all">
                {img.image}
              </div>
              {img.description && (
                <p className="text-xs text-txt-muted">{img.description}</p>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                if (k8sDebugImages.length <= 1) return;
                setK8sDebugImages((prev) => prev.filter((item) => item.id !== img.id));
              }}
              disabled={k8sDebugImages.length <= 1}
              aria-label={`Delete debug image ${img.name}`}
              title={k8sDebugImages.length <= 1 ? 'At least one debug image is required' : 'Delete debug image'}
              className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-red-400 transition-colors disabled:opacity-30 disabled:hover:text-txt-muted"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  </div>
  );
};
