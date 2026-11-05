import React, { useId } from 'react';
import type { SSHSystemMembership, SSHTunnelConfig } from '@shared/types/ssh';

interface SystemMembershipFieldsProps {
  system: SSHSystemMembership | undefined;
  /** The tunnels this profile has; the ones ticked are started with the system. */
  tunnels: SSHTunnelConfig[] | undefined;
  /** `undefined` means "not in a system". */
  onChange: (system: SSHSystemMembership | undefined) => void;
  /** Existing system names, offered while typing. */
  suggestions?: string[];
}

const INPUT =
  'rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-sm text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted';
const CHECK = 'h-4 w-4 rounded border-border-subtle text-sky-600 focus:ring-sky-500';

/**
 * "Which system is this server part of, and what does Connect all do with it": the system's name,
 * whether a terminal is opened (and where it starts) and which of the profile's tunnels are started.
 * Clearing the name takes the server out of the system.
 */
export const SystemMembershipFields: React.FC<SystemMembershipFieldsProps> = ({ system, tunnels, onChange, suggestions }) => {
  const baseId = useId();
  const listId = `${baseId}-systems`;
  const update = (patch: Partial<SSHSystemMembership>) => {
    if (!system) return;
    const next: SSHSystemMembership = { ...system, ...patch };
    if (next.shell !== false) delete next.shell;
    if (!next.startDirectory) delete next.startDirectory;
    if (!next.tunnelIds || next.tunnelIds.length === 0) delete next.tunnelIds;
    onChange(next);
  };
  const selected = new Set(system?.tunnelIds ?? []);

  return (
    <fieldset className="flex flex-col gap-2 text-txt-secondary" aria-label="System">
      <label className="flex flex-col gap-1">
        System (optional)
        <input
          value={system?.name ?? ''}
          list={suggestions && suggestions.length > 0 ? listId : undefined}
          onChange={(e) => onChange(e.target.value === '' ? undefined : { ...system, name: e.target.value })}
          className={INPUT}
          placeholder="e.g. Webshop"
        />
        {suggestions && suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
      </label>

      {system && (
        <div className="flex flex-col gap-2 rounded-lg border border-border-subtle p-3">
          <label className="flex items-center gap-2.5 text-xs text-txt-primary">
            <input type="checkbox" className={CHECK} checked={system.shell !== false} onChange={(e) => update({ shell: e.target.checked ? undefined : false })} />
            Open a terminal to this server
          </label>
          <label className="flex flex-col gap-1">
            Start directory
            <input
              value={system.startDirectory ?? ''}
              onChange={(e) => update({ startDirectory: e.target.value })}
              className={INPUT}
              placeholder="e.g. /var/www"
            />
          </label>
          {tunnels && tunnels.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span>Tunnels to start</span>
              {tunnels.map((tunnel) => (
                <label key={tunnel.id} className="flex items-center gap-2.5 text-xs text-txt-primary">
                  <input
                    type="checkbox"
                    className={CHECK}
                    checked={selected.has(tunnel.id)}
                    onChange={(e) =>
                      update({ tunnelIds: e.target.checked ? [...selected, tunnel.id] : [...selected].filter((id) => id !== tunnel.id) })
                    }
                  />
                  {tunnel.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
};
