import { useCallback, useEffect, useRef, useState } from 'react';
import type { K8sWebLoginResult } from '@shared/types/kubernetes';
import { ELECTRON_IPC_PREFIX } from './format';

const PROBE_DEBOUNCE_MS = 600;
const MIN_SERVER_LENGTH = 4;

interface UseOpenShiftWebLoginOptions {
  /** Only probe and sign in while the dialog is open. */
  enabled: boolean;
  server: string;
  insecureSkipTlsVerify: boolean;
  namespace: string;
  onSuccess: (result: K8sWebLoginResult) => void;
  onError: (message: string) => void;
}

function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(ELECTRON_IPC_PREFIX, '');
}

/**
 * OpenShift browser sign-in state for the login dialog. The cluster is probed
 * (debounced) whenever the server URL or TLS option changes, and `supported`
 * only turns true when the cluster serves OpenShift's OAuth metadata, so
 * vanilla Kubernetes and older OpenShift keep the paste flow unchanged.
 */
export function useOpenShiftWebLogin(options: UseOpenShiftWebLoginOptions) {
  const { enabled, server, insecureSkipTlsVerify, namespace, onSuccess, onError } = options;
  const [supported, setSupported] = useState(false);
  const [checking, setChecking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const probeSeq = useRef(0);
  const waitingRef = useRef(false);
  const callbacks = useRef({ onSuccess, onError });
  callbacks.current = { onSuccess, onError };

  useEffect(() => {
    const seq = ++probeSeq.current;
    const trimmed = server.trim();
    if (!enabled || trimmed.length < MIN_SERVER_LENGTH) {
      setSupported(false);
      setChecking(false);
      return;
    }
    setChecking(true);
    const timer = setTimeout(() => {
      void (async () => {
        const result = await window.multissh
          .k8sOpenShiftProbe(trimmed, insecureSkipTlsVerify)
          .then((probe) => probe.supported)
          .catch(() => false);
        if (seq === probeSeq.current) {
          setSupported(result);
          setChecking(false);
        }
      })();
    }, PROBE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, server, insecureSkipTlsVerify]);

  const cancel = useCallback(() => {
    void window.multissh.k8sOpenShiftWebLoginCancel().catch(() => {});
  }, []);

  const start = useCallback(async () => {
    if (waitingRef.current) return;
    waitingRef.current = true;
    setWaiting(true);
    try {
      const result = await window.multissh.k8sOpenShiftWebLogin({
        server: server.trim(),
        insecureSkipTlsVerify,
        namespace: namespace.trim() || undefined,
      });
      callbacks.current.onSuccess(result);
    } catch (err) {
      const message = cleanIpcError(err);
      // A cancel is the user's own action, not an error worth showing.
      if (!/cancelled/i.test(message)) callbacks.current.onError(message);
    } finally {
      waitingRef.current = false;
      setWaiting(false);
    }
  }, [server, insecureSkipTlsVerify, namespace]);

  // Leaving the dialog must not leave a callback server waiting in the background.
  useEffect(
    () => () => {
      if (waitingRef.current) void window.multissh.k8sOpenShiftWebLoginCancel().catch(() => {});
    },
    []
  );

  return { supported, checking, waiting, start, cancel };
}
