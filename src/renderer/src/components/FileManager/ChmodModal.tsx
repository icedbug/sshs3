import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Shield, X, Loader2 } from 'lucide-react';
import type { FileEntry } from '@shared/types/storage';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { describeIpcError } from '../../lib/format';
import { Button } from '../ui/Button';

interface ChmodModalProps {
  open: boolean;
  providerId: string;
  entries: FileEntry[];
  onClose: () => void;
  onSaved: () => void;
}

interface PermissionState {
  uR: boolean;
  uW: boolean;
  uX: boolean;
  gR: boolean;
  gW: boolean;
  gX: boolean;
  oR: boolean;
  oW: boolean;
  oX: boolean;
}

function parseOctalToState(octal: string): PermissionState {
  const digits = octal.replace(/^0+/, '').padStart(3, '0').slice(-3);
  const u = parseInt(digits[0], 10) || 0;
  const g = parseInt(digits[1], 10) || 0;
  const o = parseInt(digits[2], 10) || 0;

  return {
    uR: (u & 4) !== 0,
    uW: (u & 2) !== 0,
    uX: (u & 1) !== 0,
    gR: (g & 4) !== 0,
    gW: (g & 2) !== 0,
    gX: (g & 1) !== 0,
    oR: (o & 4) !== 0,
    oW: (o & 2) !== 0,
    oX: (o & 1) !== 0,
  };
}

function stateToOctal(state: PermissionState): string {
  const u = (state.uR ? 4 : 0) + (state.uW ? 2 : 0) + (state.uX ? 1 : 0);
  const g = (state.gR ? 4 : 0) + (state.gW ? 2 : 0) + (state.gX ? 1 : 0);
  const o = (state.oR ? 4 : 0) + (state.oW ? 2 : 0) + (state.oX ? 1 : 0);
  return `0${u}${g}${o}`;
}

export const ChmodModal: React.FC<ChmodModalProps> = ({
  open,
  providerId,
  entries,
  onClose,
  onSaved,
}) => {
  const [octal, setOctal] = useState('0755');
  const [perms, setPerms] = useState<PermissionState>(() => parseOctalToState('0755'));
  const [recursive, setRecursive] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasDirectory = useMemo(() => entries.some((e) => e.isDirectory), [entries]);

  useEffect(() => {
    if (open && entries.length > 0) {
      const initialPerm = entries[0].permissions || (entries[0].isDirectory ? '755' : '644');
      const normalized = initialPerm.length === 3 ? `0${initialPerm}` : initialPerm;
      setOctal(normalized);
      setPerms(parseOctalToState(normalized));
      setRecursive(false);
      setError(null);
    }
  }, [open, entries]);

  const handleBackdropClick = useModalDismiss(onClose, open, !saving);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const handleOctalChange = (val: string) => {
    const cleaned = val.replace(/[^0-7]/g, '').slice(0, 4);
    setOctal(cleaned);
    if (cleaned.length >= 3) {
      setPerms(parseOctalToState(cleaned));
    }
  };

  const handleToggle = (key: keyof PermissionState) => {
    setPerms((prev) => {
      const updated = { ...prev, [key]: !prev[key] };
      setOctal(stateToOctal(updated));
      return updated;
    });
  };

  const applyRecursiveChmod = async (remotePath: string, modeStr: string) => {
    await window.multissh.storageChmod(providerId, remotePath, modeStr);
    try {
      const children = await window.multissh.storageList(providerId, remotePath);
      for (const child of children) {
        if (child.isDirectory) {
          await applyRecursiveChmod(child.path, modeStr);
        } else {
          await window.multissh.storageChmod(providerId, child.path, modeStr);
        }
      }
    } catch {
      // Ignore directory listing failures if unreadable
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const modeStr = octal.length === 3 ? `0${octal}` : octal;
      for (const entry of entries) {
        if (recursive && entry.isDirectory) {
          await applyRecursiveChmod(entry.path, modeStr);
        } else {
          await window.multissh.storageChmod(providerId, entry.path, modeStr);
        }
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to change permissions'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Change permissions" className="w-full max-w-md rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Change Permissions (chmod)</h2>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs text-txt-secondary">
          {/* File summary */}
          <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
            <div className="text-xs text-txt-muted uppercase tracking-wider font-semibold">Target</div>
            <div className="mt-1 font-mono text-xs text-txt-primary truncate">
              {entries.length === 1 ? entries[0].name : `${entries.length} selected items`}
            </div>
          </div>

          {/* Permissions Matrix */}
          <div className="rounded-lg border border-border-subtle bg-app-surface p-3">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-divider text-xs text-txt-muted uppercase tracking-wider">
                  <th className="pb-2 font-semibold">Scope</th>
                  <th className="pb-2 text-center font-semibold">Read (r)</th>
                  <th className="pb-2 text-center font-semibold">Write (w)</th>
                  <th className="pb-2 text-center font-semibold">Execute (x)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-divider font-medium">
                <tr>
                  <td className="py-2 text-txt-primary">Owner (User)</td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Owner read"
                      checked={perms.uR}
                      onChange={() => handleToggle('uR')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Owner write"
                      checked={perms.uW}
                      onChange={() => handleToggle('uW')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Owner execute"
                      checked={perms.uX}
                      onChange={() => handleToggle('uX')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                </tr>
                <tr>
                  <td className="py-2 text-txt-primary">Group</td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Group read"
                      checked={perms.gR}
                      onChange={() => handleToggle('gR')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Group write"
                      checked={perms.gW}
                      onChange={() => handleToggle('gW')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Group execute"
                      checked={perms.gX}
                      onChange={() => handleToggle('gX')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                </tr>
                <tr>
                  <td className="py-2 text-txt-primary">Others</td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Others read"
                      checked={perms.oR}
                      onChange={() => handleToggle('oR')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Others write"
                      checked={perms.oW}
                      onChange={() => handleToggle('oW')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                  <td className="py-2 text-center">
                    <input
                      type="checkbox"
                      aria-label="Others execute"
                      checked={perms.oX}
                      onChange={() => handleToggle('oX')}
                      className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Numeric octal representation */}
          <div className="flex items-center gap-3">
            <label htmlFor="chmod-octal" className="text-xs text-txt-secondary font-medium">Octal notation:</label>
            <input
              id="chmod-octal"
              type="text"
              value={octal}
              onChange={(e) => handleOctalChange(e.target.value)}
              className="w-24 rounded-lg border border-border-subtle bg-app-input px-2 py-1 font-mono text-sm text-center text-sky-400 focus:border-sky-500 focus:outline-none"
            />
          </div>

          {/* Recursive checkbox for directories */}
          {hasDirectory && (
            <label className="flex items-center gap-2 cursor-pointer text-txt-primary">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) => setRecursive(e.target.checked)}
                className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
              />
              <span>Apply recursively to underlying files and folders</span>
            </label>
          )}

          {error && (
            <div role="alert" className="rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-divider bg-app-surface px-4 py-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ChmodModal;
