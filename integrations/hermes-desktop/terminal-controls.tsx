import { useStore } from '@nanostores/react';
import { useState } from 'react';
import { $sshs3Tools } from '@/sshs3-presentation';
import type { NativeHermesApi } from '@/sshs3-shared/nativeHermes';
import type { ShellKind } from '@/sshs3-shared/aiHub';

const bridge = (window as Window & { sshs3Shell?: NativeHermesApi }).sshs3Shell;
const shells: ShellKind[] = ['bash', 'zsh', 'fish', 'sh', 'dash', 'powershell', 'pwsh', 'cmd'];

export function Sshs3TerminalControls() {
  const tools = useStore($sshs3Tools);
  const [shell, setShell] = useState<ShellKind>('bash');
  const [error, setError] = useState('');
  if (!bridge) return null;
  const binding = [...tools.bindings].reverse().find(item => ['running', 'waiting', 'interrupted'].includes(item.task.status));
  const task = binding?.task;
  const pending = task?.changes.find(change => change.status === 'pending');
  const selected = tools.selected;
  const act = (operation: Promise<unknown>) => { setError(''); void operation.catch(reason => setError(String(reason))); };
  const button = 'rounded px-2 py-1 text-xs hover:bg-(--ui-bg-hover) border border-(--ui-border)';
  if (!selected && !task) return null;
  return <section aria-label="sshs3 terminal control" className="shrink-0 border-t border-(--ui-border) px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate" title={task?.target?.label ?? selected?.label}>Terminal · {task?.target?.label ?? selected?.label}</span>
      {task && ['running', 'waiting'].includes(task.status) ? <>
        <span>{task.status === 'waiting' ? 'Waiting for you' : 'AI working'}</span>
        <button className={button} onClick={() => act(bridge.takeover(task.id))}>Take control</button>
      </> : <>
        <span>You control</span>
        {selected && selected.state !== 'ready' && <>
          <select aria-label="Terminal shell" className="bg-transparent" value={selected.shell ?? shell} onChange={event => setShell(event.target.value as ShellKind)}>
            {shells.map(value => <option key={value} value={value}>{value}</option>)}
          </select>
          <button className={button} onClick={() => act(bridge.arm(selected.shell ?? shell))}>Connect at prompt</button>
        </>}
        {task?.status === 'interrupted' && <button className={button} onClick={() => act(bridge.resume(task.id))}>Resume target</button>}
      </>}
    </div>
    {pending && <div className="mt-2 space-y-2" role="region" aria-label="Terminal approval">
      <div>{pending.description}</div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-(--ui-bg-chrome) p-2 text-xs">{pending.command ?? `${pending.before ?? ''}\n→\n${pending.after ?? ''}`}</pre>
      <div className="flex gap-2">
        <button className={button} onClick={() => act(bridge.approve(task!.id, pending.id, true))}>Approve once</button>
        <button className={button} onClick={() => act(bridge.approve(task!.id, pending.id, false))}>Reject</button>
      </div>
    </div>}
    {task?.error && <p className="mt-1 text-amber-400">{task.error}</p>}
    {error && <p role="alert" className="mt-1 text-amber-400">{error}</p>}
  </section>;
}
