import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Globe, Home, Loader2, Shuffle, XCircle } from 'lucide-react';
import type { SSHConnectionConfig, SSHTunnelConfig, SSHTunnelType } from '@shared/types/ssh';
import { describeIpcError } from '../../lib/format';

interface SSHTunnelWizardProps {
  connection: SSHConnectionConfig;
  /** When set, edits this saved tunnel in place instead of creating a new one. */
  existingTunnel?: SSHTunnelConfig;
  /** The currently-running active-tunnel id for `existingTunnel`, if it's live — so saving an
   * edit can stop the stale-config instance before optionally starting a fresh one. */
  activeTunnelId?: string;
  /** Called after the tunnel definition has been saved to the profile (always happens),
   * and started if the user chose to. Receives the updated connection and the new tunnel. */
  onDone: (updatedConnection: SSHConnectionConfig, tunnel: SSHTunnelConfig, started: boolean) => void;
  onCancel: () => void;
}

const TYPE_INFO: Record<
  SSHTunnelType,
  { icon: React.ReactNode; title: string; blurb: string; example: string }
> = {
  local: {
    icon: <ArrowRight className="h-5 w-5" />,
    title: 'Reach a service beyond the server',
    blurb:
      'Opens a port on your own computer. Traffic sent there travels over the SSH connection to the server, and onward to an address the server can reach — e.g. a database that only listens internally.',
    example: 'Most common — e.g. "connect to a database that is only reachable from the server".',
  },
  remote: {
    icon: <Home className="h-5 w-5" />,
    title: 'Let the server reach something on your side',
    blurb:
      'Opens a port on the remote server. Traffic sent there travels back over the SSH connection to an address your own computer can reach.',
    example: 'Less common — e.g. "let the server call a webhook running locally on your computer".',
  },
  dynamic: {
    icon: <Shuffle className="h-5 w-5" />,
    title: 'SOCKS proxy via the server',
    blurb:
      'Opens a single local port that acts as a SOCKS proxy. Anything you point at it (e.g. your browser) goes out through the server, letting you reach several internal destinations without setting up one tunnel per service.',
    example: 'Good when you need to reach several different internal services, not just one.',
  },
};

function suggestLocalPort(remotePort: number): number {
  if (remotePort >= 1024) return remotePort;
  if (remotePort === 80) return 8080;
  if (remotePort === 443) return 8443;
  if (remotePort === 5432) return 5432;
  return remotePort + 10000;
}

export const SSHTunnelWizard: React.FC<SSHTunnelWizardProps> = ({
  connection,
  existingTunnel,
  activeTunnelId,
  onDone,
  onCancel,
}) => {
  const isEditing = Boolean(existingTunnel);
  const [step, setStep] = useState(existingTunnel ? 1 : 0);
  const [name, setName] = useState(existingTunnel?.name ?? '');
  const [type, setType] = useState<SSHTunnelType>(existingTunnel?.type ?? 'local');
  const [localPort, setLocalPort] = useState(String(existingTunnel?.localPort ?? 8080));
  // Skips the local-port auto-suggestion entirely when editing — an existing tunnel's port was
  // deliberately chosen, so a blur on the target-port field should never silently overwrite it.
  const [localPortTouched, setLocalPortTouched] = useState(isEditing);
  const [remoteHost, setRemoteHost] = useState(existingTunnel?.remoteHost ?? 'localhost');
  const [remotePort, setRemotePort] = useState(String(existingTunnel?.remotePort ?? 5432));
  const [description, setDescription] = useState(existingTunnel?.description ?? '');
  const [saving, setSaving] = useState<'start' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [portCheck, setPortCheck] = useState<'checking' | 'free' | 'taken' | null>(null);

  const parsedLocalPort = parseInt(localPort, 10);
  const parsedRemotePort = parseInt(remotePort, 10);

  // Local/dynamic tunnels bind on this machine, so a port already in use here is worth flagging
  // before the user hits Start — a 'remote' tunnel's "local port" binds on the server instead, so
  // there's nothing local to probe. Debounced and cancellable so a fast typist doesn't leave a
  // stale result on screen from a port they've since changed.
  useEffect(() => {
    if (type === 'remote' || Number.isNaN(parsedLocalPort) || parsedLocalPort <= 0 || parsedLocalPort > 65535) {
      setPortCheck(null);
      return;
    }
    let cancelled = false;
    setPortCheck('checking');
    const timer = setTimeout(() => {
      window.multissh
        .sshTunnelCheckPort(parsedLocalPort)
        .then((free) => {
          if (!cancelled) setPortCheck(free ? 'free' : 'taken');
        })
        .catch(() => {
          if (!cancelled) setPortCheck(null);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [type, parsedLocalPort]);

  const detailsValid = useMemo(() => {
    if (name.trim().length === 0) return false;
    if (Number.isNaN(parsedLocalPort) || parsedLocalPort <= 0 || parsedLocalPort > 65535) return false;
    if (type === 'dynamic') return true;
    return !Number.isNaN(parsedRemotePort) && parsedRemotePort > 0 && parsedRemotePort <= 65535 && remoteHost.trim().length > 0;
  }, [name, type, parsedLocalPort, parsedRemotePort, remoteHost]);

  const summarySentence = useMemo(() => {
    const host = connection.name || connection.host;
    if (type === 'local') {
      return `Opens 127.0.0.1:${localPort || '?'} on your computer. Anything sent there travels via ${host} onward to ${remoteHost || '?'}:${remotePort || '?'}.`;
    }
    if (type === 'remote') {
      return `Opens port ${localPort || '?'} on ${host}. Anything sent there travels back to ${remoteHost || '?'}:${remotePort || '?'} as seen from your computer.`;
    }
    return `Opens 127.0.0.1:${localPort || '?'} as a SOCKS proxy. Anything you send there goes out via ${host}.`;
  }, [type, localPort, remoteHost, remotePort, connection]);

  const buildTunnel = (): SSHTunnelConfig => ({
    id: existingTunnel?.id ?? crypto.randomUUID(),
    name: name.trim(),
    type,
    localPort: parsedLocalPort,
    remoteHost: type === 'dynamic' ? undefined : remoteHost.trim(),
    remotePort: type === 'dynamic' ? undefined : parsedRemotePort,
    description: description.trim() || undefined,
    enabled: true,
  });

  const handleFinish = async (start: boolean) => {
    setSaving(start ? 'start' : 'save');
    setError(null);
    const tunnel = buildTunnel();
    const nextTunnels = existingTunnel
      ? (connection.tunnels || []).map((t) => (t.id === existingTunnel.id ? tunnel : t))
      : [...(connection.tunnels || []), tunnel];
    const updatedConnection: SSHConnectionConfig = { ...connection, tunnels: nextTunnels };
    try {
      await window.multissh.profilesSaveSSH(updatedConnection);
      // Editing a tunnel that's currently running: always stop the old instance first so a
      // running tunnel never silently keeps serving the pre-edit config under the new-looking row.
      if (activeTunnelId) {
        await window.multissh.sshTunnelStop(activeTunnelId).catch(() => {});
      }
      if (start) {
        await window.multissh.sshTunnelStart(updatedConnection, tunnel);
      }
      onDone(updatedConnection, tunnel, start);
    } catch (err) {
      setError(describeIpcError(err, isEditing ? 'Failed to save the tunnel' : 'Failed to create the tunnel'));
    } finally {
      setSaving(null);
    }
  };

  const steps = ['Type', 'Details', 'Done'];

  return (
    <div className="rounded-xl border border-border-subtle bg-app-surface p-4 space-y-4 text-xs text-txt-secondary">
      {/* Step indicator */}
      <ol aria-label="Progress" className="flex items-center gap-2 text-xs text-txt-muted">
        {steps.map((label, i) => (
          <React.Fragment key={label}>
            <li
              aria-current={i === step ? 'step' : undefined}
              className={`flex items-center gap-1.5 ${i === step ? 'text-sky-400 font-semibold' : i < step ? 'text-emerald-400' : ''}`}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full border text-xs ${
                  i < step
                    ? 'border-emerald-500/60 bg-emerald-500/15'
                    : i === step
                      ? 'border-sky-500/60 bg-sky-500/15'
                      : 'border-border-subtle'
                }`}
              >
                {i < step ? <Check className="h-2.5 w-2.5" /> : i + 1}
              </span>
              {label}
              {i < step && <span className="sr-only"> (completed)</span>}
            </li>
            {i < steps.length - 1 && <li aria-hidden="true" className="h-px w-4 bg-border-subtle" />}
          </React.Fragment>
        ))}
      </ol>

      {error && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 p-2.5 text-xs text-red-300 flex items-center gap-2">
          <XCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Step 0: choose type */}
      {step === 0 && (
        <div className="space-y-2.5">
          <p className="text-xs text-txt-muted">What should this tunnel be used for?</p>
          {(Object.keys(TYPE_INFO) as SSHTunnelType[]).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={type === t}
              onClick={() => setType(t)}
              className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                type === t
                  ? 'border-sky-500/60 bg-sky-500/10'
                  : 'border-border-subtle bg-app-surface-subtle hover:bg-app-surface-hover'
              }`}
            >
              <div className={`mt-0.5 ${type === t ? 'text-sky-400' : 'text-txt-muted'}`}>{TYPE_INFO[t].icon}</div>
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-semibold text-txt-primary">{TYPE_INFO[t].title}</div>
                <div className="text-xs text-txt-muted">{TYPE_INFO[t].blurb}</div>
                <div className="text-xs italic text-txt-muted/80">{TYPE_INFO[t].example}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Step 1: details */}
      {step === 1 && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-txt-muted mb-1">Name</label>
            <input
              aria-label="Tunnel name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. jumpbox, prod-bastion"
              className="w-full rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1.5 text-sm text-txt-primary focus:border-sky-500/50 focus:outline-none"
            />
            <p className="mt-1 text-xs text-txt-muted">
              How this tunnel is labeled in the Tunnels panel — independent of the connection's own name.
            </p>
          </div>

          <div>
            <label htmlFor="tunnel-wizard-local-port" className="block text-xs font-medium text-txt-muted mb-1">
              {type === 'remote' ? 'Port opened on the server' : 'Local port (on your computer)'}
            </label>
            <input
              id="tunnel-wizard-local-port"
              type="number"
              min={1}
              max={65535}
              value={localPort}
              onChange={(e) => {
                setLocalPort(e.target.value);
                setLocalPortTouched(true);
              }}
              className={`w-full rounded-lg border bg-app-surface-subtle px-2.5 py-1.5 text-sm font-mono text-txt-primary focus:outline-none ${
                portCheck === 'taken' ? 'border-amber-500/60 focus:border-amber-500' : 'border-border-subtle focus:border-sky-500/50'
              }`}
            />
            {portCheck === 'taken' ? (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-400">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                Port {localPort} already appears to be in use on this computer.
              </p>
            ) : (
              <p className="mt-1 text-xs text-txt-muted">
                {type === 'local' && 'The address you connect to yourself, e.g. localhost:PORT in your database client.'}
                {type === 'remote' && "The port the remote server opens for you — it must be free there."}
                {type === 'dynamic' && 'Point your browser/client at a SOCKS proxy on 127.0.0.1:PORT.'}
              </p>
            )}
          </div>

          {type !== 'dynamic' && (
            <>
              <div>
                <label className="block text-xs font-medium text-txt-muted mb-1">
                  {type === 'local' ? 'Target address (as seen from the server)' : 'Target address (as seen from your computer)'}
                </label>
                <input
                  aria-label="Target host"
                  type="text"
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  placeholder="localhost"
                  className="w-full rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1.5 text-sm font-mono text-txt-primary focus:border-sky-500/50 focus:outline-none"
                />
                <p className="mt-1 text-xs text-txt-muted">
                  {type === 'local'
                    ? 'Often "localhost" if the service runs on the same machine you SSH into.'
                    : 'Often "localhost" if the service runs on your own computer.'}
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-txt-muted mb-1">Target port</label>
                <input
                  aria-label="Target port"
                  type="number"
                  min={1}
                  max={65535}
                  value={remotePort}
                  onChange={(e) => setRemotePort(e.target.value)}
                  onBlur={() => {
                    // Only auto-fill the local port suggestion until the user has typed one
                    // themselves — and only once the target port field is done being edited, so a
                    // "443" typed digit-by-digit doesn't get suggested from as soon as it reads "4".
                    if (type !== 'local' || localPortTouched) return;
                    const num = parseInt(remotePort, 10);
                    if (!Number.isNaN(num)) setLocalPort(String(suggestLocalPort(num)));
                  }}
                  placeholder="e.g. 5432 for Postgres, 3306 for MySQL"
                  className="w-full rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1.5 text-sm font-mono text-txt-primary focus:border-sky-500/50 focus:outline-none"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-txt-muted mb-1">Description (optional)</label>
            <input
              aria-label="Description (optional)"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Production database"
              className="w-full rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1.5 text-sm text-txt-primary focus:border-sky-500/50 focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Step 2: review & finish */}
      {step === 2 && (
        <div className="space-y-3">
          <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-txt-primary flex items-start gap-2">
            <Globe className="h-4 w-4 shrink-0 text-sky-400 mt-0.5" />
            <div>
              <div className="font-semibold">{name || 'Unnamed tunnel'}</div>
              <span>{summarySentence}</span>
            </div>
          </div>
          <p className="text-xs text-txt-muted">
            The tunnel is always saved on this connection so you can find it again. You choose whether to start it now or just save it for later.
          </p>
        </div>
      )}

      {/* Nav buttons */}
      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={() => (step === 0 ? onCancel() : setStep((s) => s - 1))}
          className="flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface-subtle px-3 py-1.5 text-xs text-txt-secondary hover:bg-app-surface-hover transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {step === 0 ? 'Cancel' : 'Back'}
        </button>

        {step < 2 ? (
          <button
            type="button"
            disabled={step === 1 && !detailsValid}
            onClick={() => setStep((s) => s + 1)}
            className="flex items-center gap-1 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors disabled:opacity-50"
          >
            Next
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving !== null}
              onClick={() => void handleFinish(false)}
              className="rounded-lg border border-border-subtle bg-app-surface-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors disabled:opacity-50"
            >
              {saving === 'save' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isEditing ? (
                'Save changes'
              ) : (
                'Save without starting'
              )}
            </button>
            <button
              type="button"
              disabled={saving !== null}
              onClick={() => void handleFinish(true)}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors disabled:opacity-50"
            >
              {saving === 'start' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save & start'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SSHTunnelWizard;
