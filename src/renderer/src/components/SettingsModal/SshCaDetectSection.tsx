import React, { useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { SSH_CA_UNTRUSTED_MARKER } from '@shared/types/sshCa';
import type { SshCaDetectedProvisioner, SshCaDetectedRoot, SshCaDetectResult } from '@shared/types/sshCa';
import { ELECTRON_IPC_PREFIX } from '../../lib/format';
import { formatDateTime } from '../../lib/dateFormat';
import { SshCaUrlField } from './SshCaUrlField';

interface Props {
  caUrl: string;
  onCaUrlChange: (value: string) => void;
  /** The custom root CA already entered in the form, used to verify the CA while detecting. */
  rootCaCert?: string;
  /** Called with the provisioner to use and, when it was fetched and verified, the root certificate. */
  onApply: (provisioner: SshCaDetectedProvisioner, root?: SshCaDetectedRoot) => void;
}

const inputClass =
  'rounded-md border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 font-mono';

export const SshCaDetectSection: React.FC<Props> = ({ caUrl, onCaUrlChange, rootCaCert, onApply }) => {
  const [fingerprint, setFingerprint] = useState('');
  // The fingerprint is only asked for once the CA turned out not to be trusted by this computer.
  const [askFingerprint, setAskFingerprint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SshCaDetectResult | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  // Bumped when the URL changes: an answer for the previous URL must not be shown or applied.
  const generation = useRef(0);

  const detect = async () => {
    if (busy) return;
    const gen = generation.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setApplied(null);
    try {
      const res = await window.sshs3.sshCaDetect({
        caUrl,
        rootFingerprint: fingerprint.trim() || undefined,
        rootCaCert: rootCaCert?.trim() || undefined,
      });
      if (gen !== generation.current) return;
      if (res.provisioners.length === 1) {
        onApply(res.provisioners[0], res.root);
        setApplied(res.provisioners[0].name);
      }
      setResult(res);
    } catch (err) {
      if (gen !== generation.current) return;
      const message = (err instanceof Error ? err.message : String(err)).replace(ELECTRON_IPC_PREFIX, '');
      if (message.includes(SSH_CA_UNTRUSTED_MARKER)) setAskFingerprint(true);
      setError(message);
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  };

  const use = (p: SshCaDetectedProvisioner) => {
    if (!result) return;
    onApply(p, result.root);
    setApplied(p.name);
  };

  const handleUrlChange = (value: string) => {
    onCaUrlChange(value);
    // A different CA needs its own fingerprint, and the answer for the old URL no longer applies.
    generation.current += 1;
    setBusy(false);
    setAskFingerprint(false);
    setFingerprint('');
    setError(null);
    setResult(null);
    setApplied(null);
  };

  return (
    <div className="col-span-2 flex flex-col gap-2">
      <SshCaUrlField
        value={caUrl}
        onChange={handleUrlChange}
        onDetect={() => void detect()}
        busy={busy}
        detectTestId="detect-ssh-ca-btn"
      />

      {error && (
        <div role="alert" className="text-2xs text-red-400">
          {error}
        </div>
      )}

      {askFingerprint && (
        <label className="flex flex-col gap-1 text-txt-secondary">
          Root CA fingerprint (SHA-256)
          <input
            value={fingerprint}
            onChange={(e) => setFingerprint(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void detect();
              }
            }}
            className={inputClass}
            placeholder="As printed by: step certificate fingerprint root_ca.crt"
            spellCheck={false}
            autoFocus
          />
          <span className="text-2xs text-txt-muted">
            Press Detect again. sshs3 downloads the root certificate and trusts it only if its fingerprint matches.
          </span>
        </label>
      )}

      {result?.root && (
        <div className="flex items-start gap-1.5 text-2xs text-emerald-300">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Root certificate verified: {result.root.subject}, valid until {formatDateTime(result.root.validTo)}, SHA-256{' '}
            <span className="font-mono break-all">{result.root.fingerprint}</span>
          </span>
        </div>
      )}

      {result && result.provisioners.length > 1 && (
        <div className="flex flex-col gap-1">
          <span className="text-2xs text-txt-secondary">The CA has several OIDC provisioners. Use:</span>
          {result.provisioners.map((p) => (
            <button
              key={`${p.name}|${p.clientId}`}
              type="button"
              onClick={() => use(p)}
              className="flex items-center justify-between gap-2 rounded border border-border-subtle px-2 py-1 text-left text-2xs text-txt-primary hover:bg-app-surface-hover"
            >
              <span>{p.name}</span>
              <span className="font-mono text-txt-muted">{p.issuerUrl}</span>
            </button>
          ))}
        </div>
      )}

      {applied && (
        <div className="text-2xs text-emerald-300">
          Using provisioner "{applied}": issuer URL and client ID filled in.
        </div>
      )}
    </div>
  );
};
