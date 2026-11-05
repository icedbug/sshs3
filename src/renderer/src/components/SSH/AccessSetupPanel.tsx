import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, KeyRound, Loader2, MinusCircle, XCircle } from 'lucide-react';
import type { InstallPublicKeysResult, ProbeHostResult, SSHConnectionConfig } from '@shared/types/ssh';
import { describeIpcError } from '../../lib/format';
import { accessConfigProblem } from '../../lib/accessConfig';
import { InstallKeyModal } from './InstallKeyModal';

/** 'installed' = a key went in during this session but the login has not been re-tested yet. */
export type AccessState = 'unknown' | 'verified' | 'installed' | 'failed';
type StepStatus = 'pending' | 'running' | 'ok' | 'warn' | 'failed' | 'skipped';
type StepId = 'reach' | 'hostkey' | 'methods' | 'installed' | 'verified';

interface Step {
  status: StepStatus;
  detail?: string;
}

const STEP_TITLES: Record<StepId, string> = {
  reach: 'Reach host',
  hostkey: 'Host key',
  methods: 'Login methods',
  installed: 'Key installed',
  verified: 'Login works',
};
const STEP_ORDER: StepId[] = ['reach', 'hostkey', 'methods', 'installed', 'verified'];

function initialSteps(): Record<StepId, Step> {
  return {
    reach: { status: 'pending' },
    hostkey: { status: 'pending' },
    methods: { status: 'pending' },
    installed: { status: 'pending' },
    verified: { status: 'pending' },
  };
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'running':
      return <Loader2 role="img" aria-label="Running" className="h-4 w-4 animate-spin text-sky-400" />;
    case 'ok':
      return <CheckCircle2 role="img" aria-label="OK" className="h-4 w-4 text-emerald-400" />;
    case 'warn':
      return <AlertTriangle role="img" aria-label="Warning" className="h-4 w-4 text-amber-400" />;
    case 'failed':
      return <XCircle role="img" aria-label="Failed" className="h-4 w-4 text-red-400" />;
    case 'skipped':
      return <MinusCircle role="img" aria-label="Skipped" className="h-4 w-4 text-txt-muted" />;
    default:
      return <Circle role="img" aria-label="Not started" className="h-4 w-4 text-txt-muted" />;
  }
}

/** Översätter probe-resultatet till de tre första stegen i kedjan. */
function applyProbe(probe: ProbeHostResult): Pick<Record<StepId, Step>, 'reach' | 'hostkey' | 'methods'> {
  const reach: Step = probe.reachable
    ? { status: 'ok', detail: 'The host answered.' }
    : probe.hostKey === 'rejected'
      ? { status: 'ok', detail: 'The host answered.' }
      : { status: 'failed', detail: probe.error };
  const hostkey: Step =
    probe.hostKey === 'changed'
      ? { status: 'failed', detail: probe.error }
      : probe.hostKey === 'rejected'
        ? { status: 'failed', detail: 'The host key was not trusted.' }
        : !probe.reachable
          ? { status: 'skipped' }
          : probe.hostKey === 'accepted'
            ? { status: 'warn', detail: 'New host key trusted just now.' }
            : { status: 'ok', detail: 'Known host key.' };
  const methods: Step = !probe.reachable
    ? { status: 'skipped' }
    : probe.methods.length > 0
      ? { status: 'ok', detail: `The server allows: ${probe.methods.join(', ')}.` }
      : { status: 'skipped' };
  return { reach, hostkey, methods };
}

interface AccessSetupPanelProps {
  config: SSHConnectionConfig;
  onStateChange?: (state: AccessState) => void;
  /** Ökas av föräldern när inloggningsuppgifterna ändras, så att tidigare resultat nollställs. */
  resetKey?: string;
  /** Låter föräldern (t.ex. spara-påminnelsen) öppna installationsdialogen. */
  openInstallSignal?: number;
}

export const AccessSetupPanel: React.FC<AccessSetupPanelProps> = ({
  config,
  onStateChange,
  resetKey,
  openInstallSignal,
}) => {
  const [steps, setSteps] = useState<Record<StepId, Step>>(initialSteps);
  const [running, setRunning] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [serverMethods, setServerMethods] = useState<string[] | undefined>();
  const [error, setError] = useState<string | null>(null);

  const setStep = (id: StepId, step: Step) => setSteps((prev) => ({ ...prev, [id]: step }));

  // Nollställ när det som kedjan bygger på ändras.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setSteps(initialSteps());
    setServerMethods(undefined);
    setError(null);
    onStateChange?.('unknown');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (openInstallSignal) setInstallOpen(true);
  }, [openInstallSignal]);

  const verify = async (): Promise<boolean> => {
    setStep('verified', { status: 'running', detail: 'Logging in…' });
    try {
      const res = await window.multissh.sshTestLogin(config);
      if (res.success) {
        setStep('verified', { status: 'ok', detail: 'Logged in with this profile.' });
        // Fungerar inloggningen behövs ingen installation.
        setSteps((prev) => (prev.installed.status === 'pending' ? { ...prev, installed: { status: 'skipped', detail: 'Not needed: login already works.' } } : prev));
        onStateChange?.('verified');
        return true;
      }
      setStep('verified', { status: 'failed', detail: res.error });
      onStateChange?.('failed');
      return false;
    } catch (err) {
      setStep('verified', { status: 'failed', detail: describeIpcError(err, 'Login test failed') });
      onStateChange?.('failed');
      return false;
    }
  };

  const runTest = async () => {
    setRunning(true);
    setError(null);
    setSteps(initialSteps());
    setStep('reach', { status: 'running', detail: 'Connecting (including any jump host)…' });
    try {
      const probe = await window.multissh.sshProbeHost(config);
      const mapped = applyProbe(probe);
      setSteps((prev) => ({ ...prev, ...mapped }));
      setServerMethods(probe.methods.length > 0 ? probe.methods : undefined);
      if (!probe.reachable || probe.hostKey === 'rejected' || probe.hostKey === 'changed') {
        setStep('verified', { status: 'skipped' });
        onStateChange?.('failed');
        return;
      }
      await verify();
    } catch (err) {
      setStep('reach', { status: 'failed', detail: describeIpcError(err, 'Failed to reach the host') });
      onStateChange?.('failed');
    } finally {
      setRunning(false);
    }
  };

  const handleInstalled = (result: InstallPublicKeysResult) => {
    const ok = result.success && result.results.some((r) => r.status === 'installed' || r.status === 'present');
    if (!ok) return;
    const viaPassword = result.loginMethod === 'password';
    setStep('installed', {
      status: 'ok',
      detail: viaPassword ? 'Installed (logged in with password).' : 'Installed.',
    });
    // Keep a login that was already proven; otherwise the install itself is the evidence we have.
    if (steps.verified.status !== 'ok') {
      setSteps((prev) => ({ ...prev, verified: { status: 'pending' } }));
      onStateChange?.('installed');
    }
  };

  const problem = accessConfigProblem(config);
  const canRun = !problem && !running;
  const showFailureHint =
    steps.verified.status === 'failed' && /permission denied/i.test(steps.verified.detail ?? '') && config.authType !== 'password';

  return (
    <section data-testid="access-setup-panel" className="space-y-3 rounded-xl border border-border-subtle bg-app-surface p-4">
      <div>
        <h3 className="text-xs font-semibold text-txt-primary">Access</h3>
        <p className="text-xs text-txt-muted">
          Checks the whole chain to the host and, if the key is not accepted yet, installs it (like <code>ssh-copy-id</code>)
          before you save.
        </p>
      </div>

      <ol className="space-y-1.5">
        {STEP_ORDER.map((id) => {
          const step = steps[id];
          return (
            <li key={id} data-testid={`access-step-${id}`} data-status={step.status} className="flex items-start gap-2.5 text-xs">
              <span className="mt-0.5 shrink-0">
                <StepIcon status={step.status} />
              </span>
              <div className="min-w-0">
                <div className={step.status === 'pending' || step.status === 'skipped' ? 'text-txt-muted' : 'text-txt-primary'}>
                  {STEP_TITLES[id]}
                </div>
                {step.detail && <div className="break-words text-txt-muted">{step.detail}</div>}
              </div>
            </li>
          );
        })}
      </ol>

      {error && (
        <div role="alert" className="text-xs text-red-300">
          {error}
        </div>
      )}
      {showFailureHint && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200">
          The host does not accept this profile&apos;s login yet. Install your key to set it up.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!canRun}
          onClick={() => void runTest()}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-card px-3 py-1.5 text-xs text-txt-primary transition-colors hover:bg-app-surface-hover disabled:opacity-40"
        >
          {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {running ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          disabled={!canRun}
          onClick={() => setInstallOpen(true)}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-card px-3 py-1.5 text-xs text-txt-primary transition-colors hover:bg-app-surface-hover disabled:opacity-40"
        >
          <KeyRound className="h-3.5 w-3.5" />
          Install key…
        </button>
        {problem && <span className="text-xs text-txt-muted">{problem}</span>}
      </div>

      {installOpen && (
        <InstallKeyModal
          connection={config}
          serverMethods={serverMethods}
          onInstalled={handleInstalled}
          onClose={() => setInstallOpen(false)}
        />
      )}
    </section>
  );
};
