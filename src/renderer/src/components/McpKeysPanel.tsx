import { useCallback, useEffect, useState } from 'react';

/**
 * The keys that let a person's own agent — Claude Code, Cursor, Codex —
 * reach this sshs3 over MCP. A key is shown once, here, at the moment it is
 * made: after that only its name, what it may do and when it was last used.
 */

interface KeyView {
  id: string;
  name: string;
  scopes: string[];
  serverId?: string;
  createdAt: number;
  lastUsedAt?: number;
  uses: number;
  expired: boolean;
}

const WHAT: Record<string, { label: string; hint: string }> = {
  read: {
    label: 'Read',
    hint: 'The servers, what was read from them, what changed, the knowledge base, the board. Always allowed.',
  },
  tickets: {
    label: 'Write tickets',
    hint: 'May put work in the backlog and comment on a ticket. Nothing starts by itself.',
  },
  run: {
    label: 'Run commands on one server',
    hint: 'Only on the server you choose, only in a terminal that is already open for it, and only after you approve each command in sshs3.',
  },
};

const ago = (at?: number): string => {
  if (!at) return 'never used';
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'used just now';
  if (minutes < 60) return `used ${minutes} min ago`;
  if (minutes < 48 * 60) return `used ${Math.round(minutes / 60)} h ago`;
  return `used ${Math.round(minutes / 1440)} days ago`;
};

export function McpKeysPanel({
  api,
  origin,
}: {
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  /** The address agents would use, for the line a person copies. */
  origin: string;
}): JSX.Element {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [serverId, setServerId] = useState('');
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const [problem, setProblem] = useState('');
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ keys: KeyView[] }>('/api/mcp-keys');
      setKeys(res.keys ?? []);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setProblem('');
    setBusy(true);
    try {
      const res = await api<{ token: string; key: KeyView }>('/api/mcp-keys', {
        method: 'POST',
        body: JSON.stringify({ name, scopes, serverId: serverId.trim() || undefined }),
      });
      setMade({ token: res.token, name: res.key.name });
      setName('');
      await load();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string): Promise<void> => {
    setProblem('');
    try {
      await api(`/api/mcp-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const copy = (text: string, what: string): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(''), 2000);
    });
  };

  const addCommand = made ? `claude mcp add --transport http sshs3 ${origin}/api/mcp --header "Authorization: Bearer ${made.token}"` : '';

  return (
    <div className="space-y-3 text-xs" data-testid="mcp-keys">
      <div>
        <h3 className="text-sm font-semibold text-white">Keys for your own agents (MCP)</h3>
        <p className="text-slate-400 mt-0.5 leading-relaxed">
          Give your own coding agent a key and it can ask this sshs3 about your team's servers, what changed on them, and
          what the team has written down — as you, with what you can see. A key carries what it may do, and you can take
          it back at any time.
        </p>
      </div>

      {problem && (
        <div role="alert" className="rounded-lg bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-rose-300">
          {problem}
        </div>
      )}

      {made && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 space-y-2" data-testid="mcp-new-key">
          <div className="text-emerald-200">
            <strong>“{made.name}” is ready.</strong> This is the only time it is shown. Copy it now; if you lose it, make
            a new one.
          </div>
          <div className="rounded bg-slate-950 border border-slate-800 p-2 font-mono text-[11px] text-emerald-200 break-all select-all">
            {made.token}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => copy(made.token, 'token')}
              className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold transition"
            >
              {copied === 'token' ? '✓ Copied' : 'Copy the key'}
            </button>
            <button
              type="button"
              onClick={() => copy(addCommand, 'cmd')}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 transition"
            >
              {copied === 'cmd' ? '✓ Command copied' : 'Copy the line for Claude Code'}
            </button>
            <button
              type="button"
              onClick={() => setMade(null)}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
            >
              I have it
            </button>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="space-y-1.5">
          {keys.map((k) => (
            <li
              key={k.id}
              className="rounded-lg bg-slate-900/80 border border-slate-800 px-3 py-2 flex items-center justify-between gap-3"
              data-testid={`mcp-key-${k.id}`}
            >
              <div>
                <div className="text-slate-200 font-medium">
                  {k.name} {k.expired && <span className="text-amber-300">(ran out)</span>}
                </div>
                <div className="text-slate-500 text-[11px]">
                  {k.scopes.map((s) => WHAT[s]?.label ?? s).join(' · ')}
                  {k.serverId ? ` (${k.serverId})` : ''} — {ago(k.lastUsedAt)}
                  {k.uses ? `, ${k.uses} call${k.uses === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void revoke(k.id)}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-rose-500/20 border border-slate-700 text-rose-300 transition shrink-0"
              >
                Take it back
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={create} className="space-y-2 pt-2 border-t border-slate-800">
        <label className="block text-slate-300 font-medium">
          Make a key
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What is it for — “Claude Code on my laptop”"
            aria-label="What the key is for"
            className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-white"
          />
        </label>
        <div className="space-y-1">
          {Object.entries(WHAT).map(([key, what]) => (
            <label key={key} className="flex items-start gap-2 text-slate-300">
              <input
                type="checkbox"
                checked={key === 'read' || scopes.includes(key)}
                disabled={key === 'read'}
                onChange={(e) => setScopes((s) => (e.target.checked ? [...s, key] : s.filter((x) => x !== key)))}
                className="mt-0.5"
              />
              <span>
                {what.label}
                <span className="block text-slate-500 text-[11px]">{what.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {scopes.includes('run') && (
          <label className="block text-slate-300 font-medium">
            The one server it may run on
            <input
              required
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              placeholder="The server's name, exactly as it is in sshs3"
              aria-label="The one server it may run on"
              className="mt-1 w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-white"
            />
            <span className="block text-slate-500 text-[11px]">
              A key that may run commands is for one server. Nothing it asks for runs until you approve it.
            </span>
          </label>
        )}
        <button
          type="submit"
          disabled={busy || !name.trim() || (scopes.includes('run') && !serverId.trim())}
          className="px-3 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold transition"
        >
          {busy ? 'Making it…' : 'Make the key'}
        </button>
      </form>
    </div>
  );
}
