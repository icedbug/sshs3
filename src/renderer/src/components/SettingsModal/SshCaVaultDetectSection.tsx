import React, { useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { SshCaVaultDetectResult } from '@shared/types/sshCa';
import { ELECTRON_IPC_PREFIX } from '../../lib/format';
import { SshCaUrlField } from './SshCaUrlField';

export interface VaultDetectPatch {
  vaultSshMount?: string;
  vaultAuthPath?: string;
}

interface Props {
  caUrl: string;
  onCaUrlChange: (value: string) => void;
  namespace?: string;
  rootCaCert?: string;
  /** Called with the mounts the user ended up with (one found, or one chosen). */
  onApply: (patch: VaultDetectPatch) => void;
}

const choiceClass =
  'flex items-center justify-between gap-2 rounded border border-border-subtle px-2 py-1 text-left text-2xs text-txt-primary hover:bg-app-surface-hover';

export const SshCaVaultDetectSection: React.FC<Props> = ({ caUrl, onCaUrlChange, namespace, rootCaCert, onApply }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SshCaVaultDetectResult | null>(null);
  const [chosenSsh, setChosenSsh] = useState<string | null>(null);
  const [chosenAuth, setChosenAuth] = useState<string | null>(null);
  // Bumped when the URL changes: an answer for the previous server must not be shown or applied.
  const generation = useRef(0);

  const detect = async () => {
    if (busy) return;
    const gen = generation.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setChosenSsh(null);
    setChosenAuth(null);
    try {
      const res = await window.sshs3.sshCaDetectVault({
        caUrl,
        namespace: namespace?.trim() || undefined,
        rootCaCert: rootCaCert?.trim() || undefined,
      });
      if (gen !== generation.current) return;
      const patch: VaultDetectPatch = {};
      if (res.sshMounts.length === 1) {
        patch.vaultSshMount = res.sshMounts[0].mount;
        setChosenSsh(res.sshMounts[0].mount);
      }
      if (res.authMounts.length === 1) {
        patch.vaultAuthPath = res.authMounts[0].mount;
        setChosenAuth(res.authMounts[0].mount);
      }
      if (patch.vaultSshMount || patch.vaultAuthPath) onApply(patch);
      setResult(res);
    } catch (err) {
      if (gen !== generation.current) return;
      setError((err instanceof Error ? err.message : String(err)).replace(ELECTRON_IPC_PREFIX, ''));
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  };

  const chosenKey = result?.sshMounts.find((m) => m.mount === chosenSsh);

  return (
    <div className="col-span-2 flex flex-col gap-2">
      <SshCaUrlField
        value={caUrl}
        onChange={(value) => {
          onCaUrlChange(value);
          generation.current += 1;
          setBusy(false);
          setError(null);
          setResult(null);
          setChosenSsh(null);
          setChosenAuth(null);
        }}
        onDetect={() => void detect()}
        busy={busy}
        detectTestId="detect-vault-btn"
      />
      <p className="text-2xs text-txt-muted leading-relaxed">
        Detect finds the SSH secrets engine. Roles, the OIDC issuer and the client ID cannot be detected without a
        Vault token.
      </p>

      {error && (
        <div role="alert" className="text-2xs text-red-400">
          {error}
        </div>
      )}

      {result && result.sshMounts.length === 0 && (
        <div className="text-2xs text-amber-300">
          No SSH secrets engine found at {['ssh', 'ssh-client-signer'].join(' or ')}
          {result.version ? ` (server ${result.version})` : ''}. Enter the mount name yourself.
        </div>
      )}

      {result && result.sshMounts.length > 1 && (
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-txt-secondary">Several SSH secrets engines were found. Use:</span>
          {result.sshMounts.map((m) => (
            <button
              key={m.mount}
              type="button"
              onClick={() => {
                setChosenSsh(m.mount);
                onApply({ vaultSshMount: m.mount });
              }}
              className={choiceClass}
            >
              <span className="font-mono">{m.mount}</span>
              <span className="font-mono text-txt-muted">{m.fingerprint}</span>
            </button>
          ))}
        </div>
      )}

      {chosenKey && (
        <div className="flex items-start gap-1.5 text-2xs text-emerald-300">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            SSH secrets engine "{chosenKey.mount}" found. CA key ({chosenKey.keyType}){' '}
            <span className="font-mono break-all">{chosenKey.fingerprint}</span>. Compare it with the key in
            TrustedUserCAKeys on your servers.
          </span>
        </div>
      )}

      {result && result.authMounts.length > 1 && (
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-txt-secondary">Several JWT/OIDC auth methods are listed. Use:</span>
          {result.authMounts.map((m) => (
            <button
              key={m.mount}
              type="button"
              onClick={() => {
                setChosenAuth(m.mount);
                onApply({ vaultAuthPath: m.mount });
              }}
              className={choiceClass}
            >
              <span className="font-mono">{m.mount}</span>
              <span className="text-txt-muted">{m.type}</span>
            </button>
          ))}
        </div>
      )}

      {chosenAuth && <div className="text-2xs text-emerald-300">Auth mount "{chosenAuth}" filled in.</div>}
    </div>
  );
};
