import React, { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, ShieldCheck, KeyRound, Check, Edit2, Shield, Loader2, AlertCircle } from 'lucide-react';
import type { SshCaConfig, SshCaBackendType, SshCaKeySource } from '@shared/types/sshCa';
import { useSshCa } from '../../lib/useSshCa';
import type { SettingsForm } from './useSettingsForm';
import { SshCaDetectSection } from './SshCaDetectSection';
import { SshCaVaultDetectSection } from './SshCaVaultDetectSection';

export const SshCaSettingsPanel: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const {
    sshCaConfigs,
    setSshCaConfigs,
    defaultSshCaConfigId,
    setDefaultSshCaConfigId,
  } = form;

  const { status, loading: caLoading, login } = useSshCa();

  const [editingConfig, setEditingConfig] = useState<SshCaConfig | null>(null);
  // Raw text of the principals field: parsing on every keystroke would swallow a trailing comma.
  const [principalsText, setPrincipalsText] = useState('');

  const rootRef = useRef<HTMLDivElement>(null);
  // Where focus goes when the editor closes: the edit button of that CA, or the Add CA button.
  const returnFocusTo = useRef<string | null>(null);

  const beginEdit = (cfg: SshCaConfig) => {
    setPrincipalsText(cfg.defaultPrincipals?.join(', ') ?? '');
    returnFocusTo.current = sshCaConfigs.some((c) => c.id === cfg.id) ? cfg.id : 'add';
    setEditingConfig(cfg);
  };

  const closeEditor = (focusId?: string) => {
    if (focusId) returnFocusTo.current = focusId;
    setEditingConfig(null);
  };

  useEffect(() => {
    if (editingConfig || !returnFocusTo.current) return;
    const target = returnFocusTo.current;
    returnFocusTo.current = null;
    const selector =
      target === 'add' ? '[data-testid="add-ssh-ca-btn"]' : `[data-ca-edit="${CSS.escape(target)}"]`;
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [editingConfig, sshCaConfigs]);
  const [testResult, setTestResult] = useState<{ configId: string; success: boolean; message: string } | null>(null);

  const startNewConfig = () => {
    const newCfg: SshCaConfig = {
      id: `ca-${Date.now()}`,
      name: 'New SSH CA',
      backend: 'step-ca',
      caUrl: 'https://',
      oidcIssuerUrl: 'https://',
      oidcClientId: 'step-ca',
      keySource: 'ephemeral',
      defaultPrincipals: [],
    };
    beginEdit(newCfg);
  };

  const saveEditingConfig = () => {
    if (!editingConfig) return;
    const trimmed: SshCaConfig = {
      ...editingConfig,
      name: editingConfig.name.trim() || 'SSH CA',
      caUrl: editingConfig.caUrl.trim(),
      oidcIssuerUrl: editingConfig.oidcIssuerUrl.trim(),
      oidcClientId: editingConfig.oidcClientId.trim(),
      defaultPrincipals: principalsText.split(',').map((s) => s.trim()).filter(Boolean),
      rootCaCert: editingConfig.rootCaCert?.trim() || undefined,
      vaultAuthPath: editingConfig.backend === 'vault' ? editingConfig.vaultAuthPath?.trim() || undefined : undefined,
      vaultRole: editingConfig.backend === 'vault' ? editingConfig.vaultRole?.trim() || undefined : undefined,
      vaultSshMount: editingConfig.backend === 'vault' ? editingConfig.vaultSshMount?.trim() || undefined : undefined,
      vaultSshRole: editingConfig.backend === 'vault' ? editingConfig.vaultSshRole?.trim() || undefined : undefined,
      vaultNamespace: editingConfig.backend === 'vault' ? editingConfig.vaultNamespace?.trim() || undefined : undefined,
    };

    const exists = sshCaConfigs.some((c) => c.id === trimmed.id);
    const updated = exists
      ? sshCaConfigs.map((c) => (c.id === trimmed.id ? trimmed : c))
      : [...sshCaConfigs, trimmed];

    setSshCaConfigs(updated);
    if (!defaultSshCaConfigId || updated.length === 1) {
      setDefaultSshCaConfigId(trimmed.id);
    }
    closeEditor(trimmed.id);
  };

  const deleteConfig = (id: string) => {
    const updated = sshCaConfigs.filter((c) => c.id !== id);
    setSshCaConfigs(updated);
    if (defaultSshCaConfigId === id) {
      setDefaultSshCaConfigId(updated[0]?.id);
    }
    if (editingConfig?.id === id) {
      closeEditor('add');
    }
  };

  const testLogin = async (config: SshCaConfig) => {
    setTestResult(null);
    try {
      const res = await login(config);
      setTestResult({
        configId: config.id,
        success: true,
        message: `Successfully authenticated as ${res.username}! Certificate active.`,
      });
    } catch (err) {
      setTestResult({
        configId: config.id,
        success: false,
        message: (err as Error).message,
      });
    }
  };

  return (
    <div ref={rootRef} className="rounded-lg border border-border-subtle bg-app-surface p-3.5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-txt-primary font-semibold text-xs">
          <Shield className="h-4 w-4 text-sky-400" />
          <span>SSH Certificate Authorities (SSH CA)</span>
        </div>
        {!editingConfig && (
          <button
            type="button"
            data-testid="add-ssh-ca-btn"
            onClick={startNewConfig}
            className="flex items-center gap-1 rounded-md border border-border-subtle bg-app-surface px-2 py-1 text-2xs font-medium text-txt-primary hover:bg-app-surface-hover transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Add CA
          </button>
        )}
      </div>

      <p className="text-xs text-txt-muted leading-relaxed">
        Configure automated SSH Certificate Authorities (such as Smallstep Step-CA or HashiCorp Vault).
        Users authenticate through an OpenID Connect (OIDC) identity provider, generating ephemeral OpenSSH user certificates on demand.
      </p>

      {/* Editing Modal/Form */}
      {editingConfig && (
        <div className="space-y-3 rounded-lg border border-sky-500/30 bg-app-card p-3 animate-in fade-in duration-100">
          <div className="font-semibold text-xs text-sky-400 mb-2">
            {sshCaConfigs.some((c) => c.id === editingConfig.id) ? 'Edit SSH CA' : 'New SSH CA'}
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <label className="flex flex-col gap-1 text-txt-secondary">
              Name
              <input
                value={editingConfig.name}
                onChange={(e) => setEditingConfig({ ...editingConfig, name: e.target.value })}
                className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500"
                placeholder="Step-CA Internal"
              />
            </label>

            <label className="flex flex-col gap-1 text-txt-secondary">
              Backend Provider
              <select
                value={editingConfig.backend}
                onChange={(e) => setEditingConfig({ ...editingConfig, backend: e.target.value as SshCaBackendType })}
                className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500"
              >
                <option value="step-ca">Smallstep (step-ca)</option>
                <option value="vault">OpenBao / HashiCorp Vault</option>
              </select>
            </label>

            {editingConfig.backend === 'step-ca' ? (
              <SshCaDetectSection
                caUrl={editingConfig.caUrl}
                rootCaCert={editingConfig.rootCaCert}
                onCaUrlChange={(caUrl) => setEditingConfig((prev) => prev && { ...prev, caUrl })}
                onApply={(provisioner, root) =>
                  setEditingConfig((prev) =>
                    prev && {
                      ...prev,
                      oidcIssuerUrl: provisioner.issuerUrl,
                      oidcClientId: provisioner.clientId,
                      name: prev.name === 'New SSH CA' ? provisioner.name : prev.name,
                      rootCaCert: root ? root.pem : prev.rootCaCert,
                    }
                  )
                }
              />
            ) : (
              <SshCaVaultDetectSection
                caUrl={editingConfig.caUrl}
                onCaUrlChange={(caUrl) => setEditingConfig((prev) => prev && { ...prev, caUrl })}
                namespace={editingConfig.vaultNamespace}
                rootCaCert={editingConfig.rootCaCert}
                onApply={(patch) => setEditingConfig((prev) => prev && { ...prev, ...patch })}
              />
            )}

            <label className="flex flex-col gap-1 text-txt-secondary col-span-2">
              OIDC Issuer URL
              <input
                value={editingConfig.oidcIssuerUrl}
                onChange={(e) => setEditingConfig({ ...editingConfig, oidcIssuerUrl: e.target.value })}
                className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                placeholder="https://keycloak.example.com/realms/sshca"
              />
            </label>

            <label className="flex flex-col gap-1 text-txt-secondary">
              OIDC Client ID
              <input
                value={editingConfig.oidcClientId}
                onChange={(e) => setEditingConfig({ ...editingConfig, oidcClientId: e.target.value })}
                className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                placeholder="step-ca"
              />
            </label>

            <label className="flex flex-col gap-1 text-txt-secondary">
              Key Source
              <select
                value={editingConfig.keySource}
                onChange={(e) => setEditingConfig({ ...editingConfig, keySource: e.target.value as SshCaKeySource })}
                className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500"
              >
                <option value="ephemeral">Ephemeral in-memory key (Ed25519)</option>
                <option value="piv">Smartcard / PIV (PKCS#11)</option>
              </select>
            </label>

            {editingConfig.backend === 'vault' && (
              <>
                <label className="flex flex-col gap-1 text-txt-secondary">
                  Vault Auth Mount
                  <input
                    value={editingConfig.vaultAuthPath ?? ''}
                    onChange={(e) => setEditingConfig({ ...editingConfig, vaultAuthPath: e.target.value })}
                    className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                    placeholder="jwt"
                  />
                </label>

                <label className="flex flex-col gap-1 text-txt-secondary">
                  Vault Auth Role
                  <input
                    value={editingConfig.vaultRole ?? ''}
                    onChange={(e) => setEditingConfig({ ...editingConfig, vaultRole: e.target.value })}
                    className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                    placeholder="default"
                  />
                </label>

                <label className="flex flex-col gap-1 text-txt-secondary">
                  Vault SSH Secrets Mount
                  <input
                    value={editingConfig.vaultSshMount ?? ''}
                    onChange={(e) => setEditingConfig({ ...editingConfig, vaultSshMount: e.target.value })}
                    className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                    placeholder="ssh"
                  />
                </label>

                <label className="flex flex-col gap-1 text-txt-secondary">
                  Vault SSH Role
                  <input
                    value={editingConfig.vaultSshRole ?? ''}
                    onChange={(e) => setEditingConfig({ ...editingConfig, vaultSshRole: e.target.value })}
                    className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                    placeholder="client"
                  />
                </label>

                <label className="flex flex-col gap-1 text-txt-secondary col-span-2">
                  Vault Namespace (Enterprise, optional)
                  <input
                    value={editingConfig.vaultNamespace ?? ''}
                    onChange={(e) => setEditingConfig({ ...editingConfig, vaultNamespace: e.target.value })}
                    className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                    placeholder="admin"
                  />
                </label>
              </>
            )}

            <label className="flex flex-col gap-1 text-txt-secondary col-span-2">
              Default Principals (comma-separated, optional)
              <input
                value={principalsText}
                onChange={(e) => setPrincipalsText(e.target.value)}
                className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                placeholder="alun, root"
              />
            </label>

            <label className="flex flex-col gap-1 text-txt-secondary col-span-2">
              Custom Root CA Certificate (PEM format, optional)
              <textarea
                value={editingConfig.rootCaCert ?? ''}
                onChange={(e) => setEditingConfig({ ...editingConfig, rootCaCert: e.target.value })}
                rows={3}
                className="rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-2xs text-txt-primary outline-none focus:border-sky-500 font-mono"
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
              />
              <span className="text-2xs text-txt-muted">Leave empty if your CA is in the OS trust store.</span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border-subtle">
            <button
              type="button"
              onClick={() => closeEditor()}
              className="rounded-md border border-border-subtle px-2.5 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveEditingConfig}
              className="rounded-md bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500"
            >
              Save Configuration
            </button>
          </div>
        </div>
      )}

      {/* List of configured CAs */}
      {sshCaConfigs.length === 0 ? (
        <div className="rounded border border-dashed border-border-subtle p-4 text-center text-xs text-txt-muted">
          No SSH Certificate Authorities configured yet. Click "Add CA" to set up Step-CA or Vault.
        </div>
      ) : (
        <div className="space-y-2">
          {sshCaConfigs.map((cfg) => {
            // The editor above stands in for the card of the CA being edited.
            if (editingConfig?.id === cfg.id) return null;
            const isDefault = (defaultSshCaConfigId ?? sshCaConfigs[0]?.id) === cfg.id;
            const isSessionActive = status.active && status.configId === cfg.id;

            return (
              <div
                key={cfg.id}
                className={`rounded-lg border p-3 flex flex-col gap-2 transition-colors ${
                  isDefault ? 'border-sky-500/50 bg-sky-500/5' : 'border-border-subtle bg-app-card'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs text-txt-primary">{cfg.name}</span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300 font-mono border border-zinc-700">
                      {cfg.backend}
                    </span>
                    {isDefault && (
                      <span className="rounded bg-sky-500/20 text-sky-300 px-1.5 py-0.5 text-[10px] font-medium border border-sky-500/30">
                        Default
                      </span>
                    )}
                    {isSessionActive && (
                      <span className="rounded bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 text-[10px] font-medium border border-emerald-500/30 flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3" />
                        Active ({status.username})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => setDefaultSshCaConfigId(cfg.id)}
                        className="rounded px-2 py-0.5 text-2xs text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover"
                      >
                        Set as Default
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Edit"
                      data-ca-edit={cfg.id}
                      onClick={() => beginEdit(cfg)}
                      className="rounded p-1 text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover"
                      title="Edit"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete"
                      onClick={() => deleteConfig(cfg.id)}
                      className="rounded p-1 text-txt-muted hover:text-rose-400 hover:bg-app-surface-hover"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-txt-muted font-mono">
                  <div className="truncate" title={cfg.caUrl}>
                    CA: <span className="text-txt-secondary">{cfg.caUrl}</span>
                  </div>
                  <div className="truncate" title={cfg.oidcIssuerUrl}>
                    IdP: <span className="text-txt-secondary">{cfg.oidcIssuerUrl}</span>
                  </div>
                </div>

                {testResult?.configId === cfg.id && (
                  <div
                    className={`flex items-start gap-1.5 rounded p-2 text-2xs ${
                      testResult.success
                        ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border border-rose-500/30 bg-rose-500/10 text-rose-300'
                    }`}
                  >
                    {testResult.success ? (
                      <Check className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    )}
                    <span>{testResult.message}</span>
                  </div>
                )}

                <div className="flex justify-end pt-1">
                  <button
                    type="button"
                    disabled={caLoading}
                    onClick={() => testLogin(cfg)}
                    className="flex items-center gap-1.5 rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-2xs font-medium text-sky-300 hover:bg-sky-500/20 transition-colors disabled:opacity-50"
                  >
                    {caLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
                    Authenticate with CA
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
