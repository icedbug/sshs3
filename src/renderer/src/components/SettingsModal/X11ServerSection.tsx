import React, { useId } from 'react';
import { Monitor, CheckCircle2, RefreshCw, Play, Square, FolderOpen } from 'lucide-react';
import type { SettingsForm } from './useSettingsForm';
import { ManagedNotice } from './Managed';

const MODE_OPTIONS = [
  { value: 'auto', title: 'Auto-start (Default)', hint: 'Starts VcXsrv on demand when an X11 session opens.' },
  { value: 'always', title: 'Always Running', hint: 'Launches in background when sshs3 starts up.' },
  { value: 'manual', title: 'Manual / External', hint: 'Manage server manually or use WSLg / external X server.' },
] as const;

/** The three X server start modes; read-only with an explanation when an administrator's policy locks them. */
const X11ModeOptions: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const { x11ServerMode, setX11ServerMode, isManaged } = form;
  const managed = isManaged('x11ServerMode');
  const noticeId = useId();
  return (
    <>
      <div
        role="radiogroup"
        aria-label="X server mode"
        className={`grid grid-cols-1 sm:grid-cols-3 gap-2 ${managed ? 'opacity-70' : ''}`}
      >
        {MODE_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`flex flex-col gap-1 rounded-lg border p-2.5 text-xs cursor-pointer transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-sky-500 has-[:focus-visible]:ring-offset-1 has-[:focus-visible]:ring-offset-app-surface ${
              x11ServerMode === option.value
                ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="x11ServerMode"
                disabled={managed}
                aria-describedby={managed ? noticeId : undefined}
                checked={x11ServerMode === option.value}
                onChange={() => setX11ServerMode(option.value)}
                className="sr-only"
              />
              <span>{option.title}</span>
            </div>
            <span className="text-xs text-txt-muted leading-tight">{option.hint}</span>
          </label>
        ))}
      </div>
      <ManagedNotice managed={managed} id={noticeId} />
    </>
  );
};

/** The X server command-line arguments field; locked like the mode when managed. */
const X11ArgsField: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const { x11ServerArgs, setX11ServerArgs, isManaged } = form;
  const managed = isManaged('x11ServerArgs');
  const noticeId = useId();
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-txt-primary">Server Arguments</label>
      <input
        aria-label="X server arguments"
        aria-describedby={managed ? noticeId : undefined}
        disabled={managed}
        type="text"
        value={x11ServerArgs}
        onChange={(e) => setX11ServerArgs(e.target.value)}
        placeholder=":0 -multiwindow -clipboard -wgl -ac"
        className="w-full rounded-lg border border-border-subtle bg-app-input px-3 py-1.5 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
      />
      <ManagedNotice managed={managed} id={noticeId} />
    </div>
  );
};

/** Local X11 server controls (Windows GUI forwarding) and the Linux notice, shown under Terminal settings. */
export const X11ServerSection: React.FC<{ form: SettingsForm }> = ({ form }) => {
  const {
    x11ServerPath,
    setX11ServerPath,
    x11Status,
    x11Operating,
    isLinux,
    refreshX11Status,
    handleStartX11,
    handleStopX11,
    handleBrowseX11Path,
  } = form;

  return (
    <>
    {/* Local X11 Server (Windows GUI Forwarding) */}
    <div className="space-y-3 pt-3 border-t border-divider">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-sky-400" />
          <label className="text-xs font-semibold text-txt-primary">
            Local X11 Server (GUI Forwarding)
          </label>
        </div>
        <div className="flex items-center gap-2">
          {x11Status?.running ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Running ({x11Status.display})
              {x11Status.managedByApp && x11Status.pid ? ` [PID ${x11Status.pid}]` : ''}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs font-medium bg-slate-500/10 text-txt-muted border border-slate-500/20">
              Stopped
            </span>
          )}
          <button
            aria-label="Refresh X server status"
            type="button"
            onClick={() => void refreshX11Status()}
            className="p-1 text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover rounded transition-colors"
            title="Refresh X server status"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <p className="text-xs text-txt-muted">
        {isLinux
          ? 'Allows remote Linux GUI applications (like xclock, gedit, Firefox, or IDEs) to display seamlessly on your local desktop when X11 forwarding is enabled.'
          : 'Allows Linux GUI applications (like xclock, gedit, Firefox, or IDEs) to display seamlessly on Windows when X11 forwarding is enabled.'}
      </p>

      {/* Linux Detection Notice */}
      {isLinux && (
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium text-sky-300">
              <CheckCircle2 className="h-4 w-4 text-sky-400 shrink-0" />
              <span>Linux system detected — Native display support active</span>
            </div>
            <span className="text-2xs uppercase font-semibold tracking-wider text-sky-400 bg-sky-500/20 px-2 py-0.5 rounded border border-sky-500/30">
              Native Display
            </span>
          </div>
          <p className="text-xs text-txt-secondary leading-relaxed">
            Your system uses native X11 / Wayland display forwarding ({x11Status?.display || ':0'}). External X servers (such as VcXsrv or Xming) and their launch settings are only required on Windows — no background daemon or extra configuration is needed on Linux.
          </p>
          <div className="pt-1 border-t border-sky-500/20 text-xs">
            {x11Status?.running ? (
              <span className="text-emerald-400 font-medium flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Local X11 display is active and ready for SSH forwarding. No extra settings needed.
              </span>
            ) : (
              <span className="text-amber-400 font-medium flex items-center gap-1.5">
                ⚠ No local display server found listening on {x11Status?.display || ':0'}. Ensure your X11 or Xwayland session is running.
              </span>
            )}
          </div>
        </div>
      )}

      {isLinux ? (
        <details className="group rounded-lg border border-border-subtle bg-app-surface/50 p-2.5 text-xs">
          <summary className="cursor-pointer text-txt-muted hover:text-txt-primary select-none flex items-center justify-between">
            <span className="font-medium text-txt-secondary">
              Windows X Server Settings (Optional / Only used on Windows)
            </span>
            <span className="text-2xs text-txt-muted group-open:rotate-180 transition-transform">▼</span>
          </summary>
          <div className="mt-3 space-y-3 pt-2 border-t border-divider">
            <p className="text-xs text-txt-muted">
              These settings configure VcXsrv when sshs3 runs on Windows. They are saved in your settings profile if you sync across multiple operating systems.
            </p>

            {/* Server Mode */}
            <X11ModeOptions form={form} />

            {/* Path & Controls */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-txt-primary">X Server Binary Path</label>
              <div className="flex items-center gap-2">
                <input
                  aria-label="X server binary path"
                  type="text"
                  value={x11ServerPath}
                  onChange={(e) => {
                    setX11ServerPath(e.target.value);
                    void refreshX11Status(e.target.value);
                  }}
                  placeholder="Not needed on Linux (e.g. C:\Program Files\VcXsrv\vcxsrv.exe on Windows)"
                  className="flex-1 rounded-lg border border-border-subtle bg-app-input px-3 py-1.5 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={() => void handleBrowseX11Path()}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border-subtle bg-app-surface text-xs text-txt-primary hover:bg-app-surface-hover"
                  title="Browse executable..."
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>Browse</span>
                </button>
              </div>
            </div>

            {/* Custom Arguments */}
            <X11ArgsField form={form} />

          </div>
        </details>
      ) : (
        <>
          {/* Server Mode */}
          <X11ModeOptions form={form} />

          {/* Path & Controls */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-txt-primary">X Server Binary Path</label>
              {x11Status?.available && !x11ServerPath && (
                <span className="text-2xs text-emerald-400">
                  Auto-detected: {x11Status.executablePath}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={x11ServerPath}
                onChange={(e) => {
                  setX11ServerPath(e.target.value);
                  void refreshX11Status(e.target.value);
                }}
                placeholder={x11Status?.executablePath || 'Auto-detect (e.g. C:\\Program Files\\VcXsrv\\vcxsrv.exe)'}
                className="flex-1 rounded-lg border border-border-subtle bg-app-input px-3 py-1.5 font-mono text-xs text-txt-primary outline-none focus:border-sky-500"
              />
              <button
                type="button"
                onClick={() => void handleBrowseX11Path()}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border-subtle bg-app-surface text-xs text-txt-primary hover:bg-app-surface-hover"
                title="Browse executable..."
              >
                <FolderOpen className="h-3.5 w-3.5" />
                <span>Browse</span>
              </button>
            </div>
          </div>

          {/* Custom Arguments */}
          <X11ArgsField form={form} />

          {/* Manual start/stop actions */}
          <div className="flex items-center gap-2 pt-1">
            {x11Status?.running ? (
              <button
                type="button"
                disabled={x11Operating || !x11Status.managedByApp}
                onClick={() => void handleStopX11()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 disabled:opacity-50 transition-colors"
                title={x11Status.managedByApp ? 'Stop server' : 'External server cannot be stopped from here'}
              >
                <Square className="h-3 w-3" />
                <span>Stop Server</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={x11Operating || (!x11Status?.available && !x11ServerPath)}
                onClick={() => void handleStartX11()}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
              >
                <Play className="h-3 w-3" />
                <span>Start Server Now</span>
              </button>
            )}
            {!x11Status?.running && !x11Status?.available && !x11ServerPath && (
              <span className="text-xs text-amber-400">
                VcXsrv not detected. Install VcXsrv or enter its path above.
              </span>
            )}
          </div>
        </>
      )}
    </div>
    </>
  );
};
