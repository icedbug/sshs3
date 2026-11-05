import type { TabHandoff, WindowInfo } from '../../shared/types/ipc';

/** The slice of Electron's WebContents the manager needs (structural, so tests can fake it). */
export interface ManagedWebContents {
  readonly id: number;
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface ManagedWindow {
  readonly webContents: ManagedWebContents;
  isDestroyed(): boolean;
}

/** Window operations only the main process can do (creating windows, moving tabs between them). */
export interface WindowActions {
  /** Opens a new window, optionally for a tab that is moving there. */
  open(handoff?: TabHandoff): void;
  /** Hands a tab to an existing window; false when that window is gone or is the sender itself. */
  adopt(targetWindowId: number, handoff: TabHandoff, fromWindowId: number): boolean;
  /** The tab a freshly opened window was created for, once. */
  takeHandoff(windowId: number): TabHandoff | null;
  list(currentWindowId: number | undefined): WindowInfo[];
}

/** What IpcBridge needs from the window layer to route events (WindowManager implements it). */
export interface WindowRouter {
  sendToSession(sessionId: string, channel: string, ...args: unknown[]): boolean;
  broadcast(channel: string, ...args: unknown[]): void;
  /** Like broadcast, but skips one window (undefined skips none). */
  broadcastExcept(windowId: number | undefined, channel: string, ...args: unknown[]): void;
  assign(sessionId: string, windowId: number): void;
  windowIdOfSender(sender: { id: number } | null | undefined): number | undefined;
  /** Persistence key of the sender's window: null for the main window, a string for the others. */
  keyOfSender(sender: { id: number } | null | undefined): string | null;
}

/**
 * Registry of the app's renderer windows, and the single place that decides which window an IPC
 * event goes to: session events go to the window that owns the session, prompts go to the window
 * the user is looking at, and broadcasts reach all of them.
 */
export class WindowManager<W extends ManagedWindow = ManagedWindow> implements WindowRouter {
  private readonly windows = new Map<number, W>();
  private readonly sessionOwner = new Map<string, number>();
  private readonly windowKey = new Map<number, string>();
  /** Tabs waiting for a freshly opened window to pick them up (see takeHandoff). */
  private readonly handoffs = new Map<number, unknown>();
  /** Sessions on their way to another window: sessionId -> target window. Cleared by assign(). */
  private readonly reserved = new Map<string, number>();
  private focusedId: number | null = null;

  /** Adds a window; the first one (or the last focused) is what prompts fall back to. Returns its id. */
  register(win: W, key: string | null = null): number {
    const id = win.webContents.id;
    this.windows.set(id, win);
    if (key !== null) this.windowKey.set(id, key);
    this.focusedId = id;
    return id;
  }

  /** Forgets a window and every session it owned (their renderer is gone). Returns the released session ids. */
  unregister(windowId: number): string[] {
    this.windows.delete(windowId);
    this.windowKey.delete(windowId);
    this.handoffs.delete(windowId);
    if (this.focusedId === windowId) {
      const remaining = this.live();
      this.focusedId = remaining.length > 0 ? remaining[remaining.length - 1].webContents.id : null;
    }
    return this.releaseWindow(windowId);
  }

  setFocused(windowId: number): void {
    if (this.windows.has(windowId)) this.focusedId = windowId;
  }

  get(windowId: number): W | undefined {
    return this.windows.get(windowId);
  }

  list(): W[] {
    return this.live();
  }

  get size(): number {
    return this.windows.size;
  }

  /** The window prompts and global dialogs are shown in: the focused one, else any live window. */
  focused(): W | undefined {
    const focused = this.focusedId !== null ? this.windows.get(this.focusedId) : undefined;
    if (focused && !focused.isDestroyed()) return focused;
    const live = this.live();
    return live[live.length - 1];
  }

  focusedWebContents(): ManagedWebContents | undefined {
    return this.focused()?.webContents;
  }

  /** Window id for the sender of an IPC call, or undefined when it is not one of our windows. */
  windowIdOfSender(sender: { id: number } | null | undefined): number | undefined {
    return sender && this.windows.has(sender.id) ? sender.id : undefined;
  }

  keyOfSender(sender: { id: number } | null | undefined): string | null {
    return (sender && this.windowKey.get(sender.id)) ?? null;
  }

  /** Persistence key of a window (null for the main window), or undefined when it is not registered. */
  keyOf(windowId: number): string | null | undefined {
    return this.windows.has(windowId) ? (this.windowKey.get(windowId) ?? null) : undefined;
  }

  /** True only for the top-level frame of a registered window; anything else is untrusted. */
  isTrustedFrame(frame: unknown): boolean {
    if (!frame) return false;
    for (const win of this.live()) {
      if (win.webContents.mainFrame === frame) return true;
    }
    return false;
  }

  assign(sessionId: string, windowId: number): void {
    if (!this.windows.has(windowId)) return;
    this.sessionOwner.set(sessionId, windowId);
    this.reserved.delete(sessionId);
  }

  release(sessionId: string): void {
    this.sessionOwner.delete(sessionId);
  }

  ownerOf(sessionId: string): number | undefined {
    return this.sessionOwner.get(sessionId);
  }

  /**
   * Sessions the window owns and is not about to hand to another window, plus the ones on their way
   * to it: a session moved into a window that is closed before it attached would otherwise keep
   * running with no tab and no owner that answers for it.
   */
  sessionsOf(windowId: number): string[] {
    const ids = new Set<string>();
    for (const [sessionId, owner] of this.sessionOwner) {
      if (owner === windowId && !this.isReservedForOther(sessionId, windowId)) ids.add(sessionId);
    }
    for (const [sessionId, target] of this.reserved) {
      if (target === windowId) ids.add(sessionId);
    }
    return [...ids];
  }

  /**
   * Marks sessions as moving to `toWindowId`. Ownership only changes when that window claims them
   * with assign() (so output keeps flowing to a single place until it does), but until then they are
   * no longer counted as the old window's: closing it must not end a session that is being moved.
   * The reservation lapses after `ttlMs` if the target never claims them.
   */
  reserve(sessionIds: string[], toWindowId: number, ttlMs = 30_000): void {
    for (const sessionId of sessionIds) {
      this.reserved.set(sessionId, toWindowId);
      const timer = setTimeout(() => {
        if (this.reserved.get(sessionId) === toWindowId) this.reserved.delete(sessionId);
      }, ttlMs);
      timer.unref?.();
    }
  }

  /** Parks a payload (e.g. a moved tab) for the window that was just created to fetch once. */
  setHandoff(windowId: number, payload: unknown): void {
    this.handoffs.set(windowId, payload);
  }

  takeHandoff(windowId: number): unknown {
    const payload = this.handoffs.get(windowId);
    this.handoffs.delete(windowId);
    return payload;
  }

  /** Live windows in creation order, for "Move to window" menus. */
  describe(): Array<{ id: number; key: string | null }> {
    return this.live().map((w) => ({ id: w.webContents.id, key: this.windowKey.get(w.webContents.id) ?? null }));
  }

  private isReservedForOther(sessionId: string, windowId: number): boolean {
    const target = this.reserved.get(sessionId);
    return target !== undefined && target !== windowId;
  }

  /** Hands every listed session to another window (tab moved between windows). */
  transfer(sessionIds: string[], toWindowId: number): void {
    for (const sessionId of sessionIds) this.assign(sessionId, toWindowId);
  }

  /**
   * Sends a session-bound event to the owning window. A session that has no (live) owner falls back
   * to the focused window, so output is never silently dropped while ownership is being set up.
   */
  sendToSession(sessionId: string, channel: string, ...args: unknown[]): boolean {
    const ownerId = this.sessionOwner.get(sessionId);
    const owner = ownerId !== undefined ? this.windows.get(ownerId) : undefined;
    const target = owner && !owner.isDestroyed() ? owner.webContents : this.focusedWebContents();
    if (!target || target.isDestroyed()) return false;
    target.send(channel, ...args);
    return true;
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const win of this.live()) win.webContents.send(channel, ...args);
  }

  broadcastExcept(windowId: number | undefined, channel: string, ...args: unknown[]): void {
    for (const win of this.live()) {
      if (win.webContents.id !== windowId) win.webContents.send(channel, ...args);
    }
  }

  private releaseWindow(windowId: number): string[] {
    const released = this.sessionsOf(windowId);
    for (const sessionId of released) {
      this.sessionOwner.delete(sessionId);
      this.reserved.delete(sessionId);
    }
    return released;
  }

  private live(): W[] {
    return [...this.windows.values()].filter((w) => !w.isDestroyed());
  }
}
