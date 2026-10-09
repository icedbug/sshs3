import React, { useEffect, useState } from 'react';
import { DEFAULT_AI_MODELS, type AiConfigView, type AiProvider } from '@shared/types/ai';
import { AI_CONFIG_CHANGED_EVENT } from '../../lib/aiTerminal';

const IPC_PREFIX = /^Error invoking remote method '[^']+':\s*(Error:\s*)?/i;

const inputClass =
  'w-full rounded-lg border border-border-subtle bg-app-input px-3 py-2 text-xs text-txt-primary outline-none focus:border-sky-500';

/**
 * The "AI Assistant" page of the settings dialog. Saves through its own channel into
 * ai-config.json (kept out of settings.json so it never travels with profile sync), so
 * like the Synchronization page it has its own Save button instead of the dialog's.
 */
export const AiSettingsPanel: React.FC = () => {
  const [loaded, setLoaded] = useState<AiConfigView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = (view: AiConfigView): void => {
    setLoaded(view);
    setEnabled(view.enabled);
    setProvider(view.provider);
    setModel(view.model);
    setBaseUrl(view.baseUrl ?? '');
    setApiKey('');
  };

  useEffect(() => {
    window.multissh
      .aiGetConfig()
      .then(apply)
      .catch(() => setStatus({ kind: 'error', message: 'Could not load the AI assistant settings.' }));
  }, []);

  const changeProvider = (next: AiProvider): void => {
    setProvider(next);
    // Model names don't carry over between providers.
    if (!model || model === DEFAULT_AI_MODELS[provider]) setModel(DEFAULT_AI_MODELS[next]);
  };

  const save = async (removeKey = false): Promise<void> => {
    setSaving(true);
    setStatus(null);
    try {
      const view = await window.multissh.aiSaveConfig({
        enabled,
        provider,
        model,
        baseUrl,
        ...(removeKey ? { apiKey: null } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      apply(view);
      window.dispatchEvent(new CustomEvent(AI_CONFIG_CHANGED_EVENT));
      setStatus({ kind: 'ok', message: removeKey ? 'API key removed.' : 'Saved.' });
    } catch (err) {
      setStatus({ kind: 'error', message: (err instanceof Error ? err.message : String(err)).replace(IPC_PREFIX, '') });
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return <p className="text-xs text-txt-muted">{status?.message ?? 'Loading…'}</p>;
  }

  return (
    <div className="space-y-4" data-testid="ai-settings">
      <label className="flex items-center gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="ai-enabled"
          className="h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500"
        />
        <span className="text-xs text-txt-primary">Enable the AI assistant in terminals</span>
      </label>
      <p className="text-xs text-txt-muted">
        Press the AI Assistant shortcut (Ctrl+Shift+A by default) in a terminal to get a command suggested from a description,
        or to have selected output explained. Type a description at the prompt and press Ctrl+Shift+Space to turn it into a
        command in place, and click Explain this error when a command fails. Nothing is sent until you ask, you can see which
        terminal text was included, and common secret formats are masked first. Commands are only typed into the terminal;
        you run them yourself.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-txt-primary" htmlFor="ai-provider">
            Provider
          </label>
          <select id="ai-provider" value={provider} onChange={(e) => changeProvider(e.target.value as AiProvider)} className={inputClass}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai-compatible">OpenAI-compatible (Ollama, LM Studio, …)</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-txt-primary" htmlFor="ai-model">
            Model
          </label>
          <input id="ai-model" type="text" value={model} onChange={(e) => setModel(e.target.value)} className={inputClass} />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-txt-primary" htmlFor="ai-base-url">
          Endpoint {provider === 'anthropic' ? '(optional)' : ''}
        </label>
        <input
          id="ai-base-url"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:11434/v1'}
          className={inputClass}
        />
        {provider === 'openai-compatible' && (
          <p className="text-xs text-txt-muted">
            A local model keeps terminal text on this machine. The endpoint must serve /chat/completions.
          </p>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-txt-primary" htmlFor="ai-api-key">
          API key {provider === 'openai-compatible' ? '(if the server needs one)' : ''}
        </label>
        <div className="flex gap-2">
          <input
            id="ai-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={loaded.hasApiKey ? '•••••••• saved — type to replace' : 'Not set'}
            className={inputClass}
          />
          {loaded.hasApiKey && (
            <button
              type="button"
              onClick={() => void save(true)}
              disabled={saving}
              className="shrink-0 rounded-lg border border-border-subtle px-3 py-2 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-rose-400 cursor-pointer"
            >
              Remove
            </button>
          )}
        </div>
        <p className="text-xs text-txt-muted">
          Stored encrypted with the OS keyring, like saved passwords, and only on this computer: AI settings are not part of
          profile sync.
        </p>
      </div>

      <div className="flex items-center justify-end gap-3">
        {status && (
          <p role={status.kind === 'error' ? 'alert' : 'status'} className={`mr-auto text-xs ${status.kind === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}>
            {status.message}
          </p>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          data-testid="ai-save"
          className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors disabled:opacity-50"
        >
          Save AI settings
        </button>
      </div>
    </div>
  );
};
