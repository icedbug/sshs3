import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Clock, HelpCircle, Search } from "lucide-react";
import {
  filterInboxItems,
  inboxItems,
  inboxPriorityBucket,
  isInboxItemSnoozed,
  type InboxItem,
  type InboxKind,
  type InboxPriorityBucket,
} from "@shared/aiHubInbox";
import type { AgentChange, HubRequest, HubSnapshot } from "@shared/types/aiHub";
import { copyToClipboard } from "../../lib/clipboard";
import { ChangeProof } from "./ChangeProof";
import { ConfirmButton } from "./ConfirmButton";
import { DiffViewer } from "./DiffViewer";
import { SECRETS_ELSEWHERE, takesSecrets } from "./ChangeSecrets";
import { ChatWaitingList } from "./AgentInChatCard";
import { TABULAR_NUMS_CLASS, TABULAR_NUMS_STYLE, type Act } from "./panelShared";
import { RichMarkdownContent } from "./RichMarkdownContent";

export interface InboxViewProps {
  hub: HubSnapshot;
  act: Act;
  onOpenTask: (taskId: string) => void;
  onOpenView: (
    view: "Workforce" | "Knowledge Base" | "Infrastructure",
    detail?: { kbTab?: "pages" | "sources" | "runbooks" | "review" },
  ) => void;
  /** Opens a ticket on the Workforce board. */
  onOpenTicket?: (ticketId: string) => void;
  /** The item a notification's link pointed at: shown first, or said to be handled if it is gone. */
  focusItemId?: string;
  /** Optional request callback override (defaults to `act`). */
  onRequest?: Act;
}

type InboxSectionFilter = "all" | InboxPriorityBucket | "snoozed";

interface SectionSpec {
  id: InboxPriorityBucket | "snoozed";
  title: string;
  testId: string;
}

const PRIORITY_SECTIONS: readonly SectionSpec[] = [
  { id: "blocking", title: "Needs Decision", testId: "inbox-section-blocking" },
  { id: "incident", title: "Urgent Alerts", testId: "inbox-section-incident" },
  { id: "review", title: "Findings & Suggestions", testId: "inbox-section-review" },
];

const SNOOZED_SECTION: SectionSpec = {
  id: "snoozed",
  title: "Put off until later",
  testId: "inbox-section-snoozed",
};

const KIND: Record<InboxKind, { label: string; tone: string }> = {
  approval: { label: "Wants to run", tone: "ai-inbox-now" },
  peer: { label: "Needs a second person", tone: "ai-inbox-now" },
  plan: { label: "Plan to decide", tone: "ai-inbox-now" },
  question: { label: "Asks you", tone: "ai-inbox-now" },
  alert: { label: "Alert", tone: "ai-inbox-warn" },
  blocked: { label: "Stopped", tone: "ai-inbox-warn" },
  health: { label: "Server", tone: "ai-inbox-warn" },
  review: { label: "To review", tone: "" },
  report: { label: "Report", tone: "" },
  knowledge: { label: "Knowledge base", tone: "" },
};

const ago = (at: number): string => {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};

/** Formats remaining snooze duration as a compact countdown string. */
function formatSnoozeCountdown(snoozedUntil: number | undefined, now = Date.now()): string {
  if (typeof snoozedUntil !== "number") return "Put off";
  const remainingMs = Math.max(0, snoozedUntil - now);
  const mins = Math.ceil(remainingMs / 60_000);
  if (mins <= 1) return "Back in under a minute";
  if (mins < 60) return `Back in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Back in ${hours} h`;
  const days = Math.round(hours / 24);
  return `Back in ${days} d`;
}

function tomorrowMorningMs(now: number): number {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next.getTime();
}

function isTypingElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("[contenteditable='true']"));
}

/** How many lines of a waiting change the Inbox shows before the person asks for the rest. */
const PEEK_LINES = 12;

/**
 * What the Inbox shows of a waiting change at first, and whether that is all of it. A long command or diff
 * is cut to its first lines, and a file change that came without a diff shows its content only when opened.
 */
export function waitingChangeText(
  detail: string | undefined,
  change: Pick<AgentChange, "kind" | "diff" | "before" | "after"> | undefined,
): { peek: string; lineCount: number; fileContent: boolean; long: boolean } {
  const lines = (detail ?? "").split("\n");
  const cut = lines.length > PEEK_LINES;
  const fileContent = Boolean(
    change && change.kind === "file" && !change.diff && (change.before !== undefined || change.after !== undefined),
  );
  return {
    peek: cut ? `${lines.slice(0, PEEK_LINES).join("\n")}\n…` : (detail ?? ""),
    lineCount: lines.length,
    fileContent,
    long: cut || fileContent,
  };
}

function matchesQuery(item: InboxItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [item.title, item.detail, item.from, item.target, item.kind]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/** Everything that is waiting for a person, grouped by priority with keyboard triage and snooze. */
export function InboxView({
  hub,
  act,
  onOpenTask,
  onOpenView,
  onOpenTicket,
  focusItemId,
  onRequest,
}: InboxViewProps): JSX.Element {
  const dispatch = onRequest ?? act;
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [address, setAddress] = useState("");
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [copyAddressFailed, setCopyAddressFailed] = useState(false);
  const [hookStatus, setHookStatus] = useState("");
  const [pasted, setPasted] = useState("");
  const [rules, setRules] = useState<{ match: string; agentId: string }[] | undefined>();
  const [ruleNotice, setRuleNotice] = useState<{ text: string; isError: boolean } | undefined>();
  const [query, setQuery] = useState("");
  const [exceptionReasons, setExceptionReasons] = useState<Record<string, string>>({});
  const [sectionFilter, setSectionFilter] = useState<InboxSectionFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(focusItemId ?? null);
  const [snoozeMenuId, setSnoozeMenuId] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [armedDoneId, setArmedDoneId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Waiting changes whose whole text the person opened, and the one that was opened by pressing Approve.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [readFirstId, setReadFirstId] = useState<string | null>(null);
  // Items with a request on its way. The ref answers at once: a double click arrives before the next render.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());

  const focused = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The item this person last answered, and whether the focus was in the Inbox when they did.
  const actedOn = useRef<string | null>(null);
  const keepFocus = useRef(false);

  const chatWaiting = hub.chatAnswering?.waiting ?? [];
  const allItems = useMemo(
    () => inboxItems(hub, { snoozeFilter: "all", now }),
    [hub, now],
  );

  const hasSnoozed = useMemo(
    () => allItems.some((item) => typeof item.snoozedUntil === "number" && item.snoozedUntil > now),
    [allItems, now],
  );

  useEffect(() => {
    if (!hasSnoozed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [hasSnoozed]);

  const activeItems = useMemo(
    () => filterInboxItems(allItems, { snoozeFilter: "active", now }).filter((i) => matchesQuery(i, query)),
    [allItems, now, query],
  );

  const snoozedItems = useMemo(
    () => filterInboxItems(allItems, { snoozeFilter: "snoozed", now }).filter((i) => matchesQuery(i, query)),
    [allItems, now, query],
  );

  const sectionsToRender = useMemo(() => {
    const groups: Array<{ spec: SectionSpec; items: InboxItem[] }> = [];
    if (sectionFilter === "all" || sectionFilter === "blocking" || sectionFilter === "incident" || sectionFilter === "review") {
      for (const spec of PRIORITY_SECTIONS) {
        if (sectionFilter !== "all" && sectionFilter !== spec.id) continue;
        const bucketItems = filterInboxItems(activeItems, {
          bucket: spec.id as InboxPriorityBucket,
          snoozeFilter: "active",
          now,
        });
        if (bucketItems.length > 0) {
          groups.push({ spec, items: bucketItems });
        }
      }
    }
    if ((sectionFilter === "all" || sectionFilter === "snoozed") && snoozedItems.length > 0) {
      groups.push({ spec: SNOOZED_SECTION, items: snoozedItems });
    }
    return groups;
  }, [activeItems, snoozedItems, sectionFilter, now]);

  const visibleItems = useMemo(
    () => sectionsToRender.flatMap((group) => group.items),
    [sectionsToRender],
  );

  const bucketCounts = useMemo(() => {
    const activeAll = filterInboxItems(allItems, { snoozeFilter: "active", now });
    const snoozedAll = filterInboxItems(allItems, { snoozeFilter: "snoozed", now });
    return {
      all: activeAll.length,
      blocking: filterInboxItems(activeAll, { bucket: "blocking", snoozeFilter: "active", now }).length,
      incident: filterInboxItems(activeAll, { bucket: "incident", snoozeFilter: "active", now }).length,
      review: filterInboxItems(activeAll, { bucket: "review", snoozeFilter: "active", now }).length,
      snoozed: snoozedAll.length,
    };
  }, [allItems, now]);

  const focusPresent = Boolean(focusItemId && allItems.some((i) => i.id === focusItemId));

  useEffect(() => {
    if (focusPresent) focused.current?.scrollIntoView?.({ block: "center" });
  }, [focusPresent, focusItemId]);

  useEffect(() => {
    if (!selectedId || visibleItems.some((i) => i.id === selectedId)) return;
    // The selected item is gone. After this person's own answer the selection moves on, so they can keep
    // going. When it went away by itself (answered elsewhere, the agent stopped, a filter), nothing is
    // selected: the next key must not land on an item the person never chose.
    const mine = actedOn.current === selectedId;
    actedOn.current = null;
    setSelectedId(mine ? (visibleItems[0]?.id ?? null) : null);
  }, [visibleItems, selectedId]);

  useEffect(() => {
    // The button that was pressed went away with its item: the focus stays in the Inbox.
    if (!keepFocus.current) return;
    const root = rootRef.current;
    const at = document.activeElement;
    if (root && (!at || at === document.body)) {
      keepFocus.current = false;
      root.focus({ preventScroll: true });
    }
  }, [visibleItems]);

  const intake = hub.alertIntake;
  const agents = hub.agents ?? [];
  const shownRules = rules ?? intake?.rules ?? [];
  const note = useCallback((id: string): string => notes[id] ?? "", [notes]);

  // Marking a ticket done from the keyboard takes two presses. The first one stops waiting after 10 s.
  useEffect(() => {
    if (!armedDoneId) return;
    const timer = window.setTimeout(() => setArmedDoneId(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [armedDoneId]);

  const openItem = useCallback(
    (item: InboxItem): void => {
      if (item.taskId) {
        onOpenTask(item.taskId);
      } else if (item.ticketId && onOpenTicket) {
        onOpenTicket(item.ticketId);
      } else if (item.kind === "alert") {
        onOpenView("Workforce");
      } else if (item.kind === "health") {
        onOpenView("Infrastructure");
      } else if (item.kind === "knowledge") {
        onOpenView("Knowledge Base", { kbTab: "review" });
      }
    },
    [onOpenTask, onOpenTicket, onOpenView],
  );

  /**
   * Sends one answer for an item. While it is on its way a second one for the same item is dropped, so a
   * double click or a held key cannot approve twice.
   */
  const send = useCallback(
    async (itemId: string, request: HubRequest): Promise<HubSnapshot | undefined> => {
      if (inFlight.current.has(itemId)) return undefined;
      inFlight.current.add(itemId);
      setBusyIds(new Set(inFlight.current));
      actedOn.current = itemId;
      keepFocus.current = Boolean(rootRef.current?.contains(document.activeElement));
      try {
        return await dispatch(request);
      } finally {
        inFlight.current.delete(itemId);
        setBusyIds(new Set(inFlight.current));
      }
    },
    [dispatch],
  );

  const changeOf = useCallback(
    (item: InboxItem): AgentChange | undefined =>
      hub.tasks.find((t) => t.id === item.taskId)?.changes.find((c) => c.id === item.changeId),
    [hub.tasks],
  );

  /**
   * Approves a waiting change. The person approves what they have read: when the Inbox shows only the
   * start of it, the first press opens all of it and the next one approves.
   */
  const approveChange = (item: InboxItem, extra?: { adminException: true; note: string }): void => {
    if (!item.taskId || !item.changeId) return;
    const change = changeOf(item);
    // A setting that takes a token is answered on its own card, where the token is typed.
    if (takesSecrets(change)) return;
    if (waitingChangeText(item.detail, change).long && !expanded[item.id]) {
      setExpanded((all) => ({ ...all, [item.id]: true }));
      setReadFirstId(item.id);
      return;
    }
    setReadFirstId(null);
    void send(item.id, { action: "approve", taskId: item.taskId, changeId: item.changeId, approved: true, ...extra });
  };

  const resolveOrArchiveItem = useCallback(
    (item: InboxItem): void => {
      switch (item.kind) {
        case "health":
          void send(item.id, { action: "facts-problem-dismiss", serverId: item.serverId! });
          break;
        case "knowledge":
          void send(item.id, { action: "kb-finding-dismiss", id: item.findingId! });
          break;
        case "report":
          void send(item.id, { action: "daily-report-read" });
          break;
        case "review":
        case "blocked":
          void send(item.id, {
            action: "ticket-review",
            id: item.ticketId!,
            approve: true,
            note: note(item.id),
          });
          break;
        default:
          void send(item.id, { action: "ack-inbox", itemId: item.id, acknowledged: true });
          break;
      }
    },
    [send, note],
  );

  const snoozeItem = useCallback(
    (item: InboxItem, preset: "1h" | "4h" | "tomorrow"): void => {
      const currentNow = Date.now();
      if (preset === "1h") {
        void send(item.id, {
          action: "snooze-inbox",
          itemId: item.id,
          durationMinutes: 60,
          until: currentNow + 60 * 60_000,
        });
      } else if (preset === "4h") {
        void send(item.id, {
          action: "snooze-inbox",
          itemId: item.id,
          durationMinutes: 240,
          until: currentNow + 240 * 60_000,
        });
      } else {
        const until = tomorrowMorningMs(currentNow);
        const durationMinutes = Math.max(1, Math.round((until - currentNow) / 60_000));
        void send(item.id, {
          action: "snooze-inbox",
          itemId: item.id,
          durationMinutes,
          until,
        });
      }
      setSnoozeMenuId(null);
    },
    [send],
  );

  // The keys act only while the focus is inside the Inbox. A letter typed in a terminal, a file list or a
  // dialog elsewhere in the window is not an answer to what waits here.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // Another control already took this key (a list's type-ahead, a menu).
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingElement(event.target)) return;

    if (event.key === "?") {
      event.preventDefault();
      setShowShortcuts((open) => !open);
      return;
    }

    if (event.key === "Escape") {
      if (showShortcuts || snoozeMenuId || armedDoneId) {
        event.preventDefault();
        setShowShortcuts(false);
        setSnoozeMenuId(null);
        setArmedDoneId(null);
      }
      return;
    }

    if (visibleItems.length === 0) return;

    const currentIdx = selectedId ? visibleItems.findIndex((i) => i.id === selectedId) : -1;

    if (event.key === "j") {
      event.preventDefault();
      const nextIdx = currentIdx < 0 ? 0 : Math.min(visibleItems.length - 1, currentIdx + 1);
      const next = visibleItems[nextIdx];
      if (next) {
        setSelectedId(next.id);
        setArmedDoneId(null);
        itemRefs.current[next.id]?.scrollIntoView?.({ block: "nearest" });
      }
      return;
    }

    if (event.key === "k") {
      event.preventDefault();
      const prevIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
      const prev = visibleItems[prevIdx];
      if (prev) {
        setSelectedId(prev.id);
        setArmedDoneId(null);
        itemRefs.current[prev.id]?.scrollIntoView?.({ block: "nearest" });
      }
      return;
    }

    // Every other key answers the selected item. With nothing selected there is nothing to answer:
    // it never falls back to the first item in the list. A held key answers once, not once per repeat.
    const active = currentIdx >= 0 ? visibleItems[currentIdx] : undefined;
    if (!active || event.repeat) return;

    if (event.key === "o" || event.key === "Enter") {
      if (
        event.key === "Enter" &&
        event.target instanceof HTMLElement &&
        Boolean(event.target.closest("button, a, summary"))
      ) {
        return;
      }
      event.preventDefault();
      openItem(active);
      return;
    }

    if (event.key === "e") {
      event.preventDefault();
      // One stray key must not close a ticket: the first press asks, the second does it.
      const isTicket = active.kind === "review" || active.kind === "blocked";
      if (isTicket && armedDoneId !== active.id) {
        setArmedDoneId(active.id);
        return;
      }
      setArmedDoneId(null);
      resolveOrArchiveItem(active);
      return;
    }

    if (event.key === "h") {
      event.preventDefault();
      setSnoozeMenuId((prev) => (prev === active.id ? null : active.id));
      return;
    }

    if (event.key === "a") {
      if (active.kind === "approval" && active.taskId && active.changeId) {
        event.preventDefault();
        // The key does what the button does, and nothing the button does not offer.
        approveChange(active);
      } else if (active.kind === "plan" && active.taskId) {
        event.preventDefault();
        void send(active.id, { action: "plan-decide", taskId: active.taskId, approved: true });
      }
    }
  };

  const createAlertAddress = (): void => {
    setCopiedAddress(false);
    setCopyAddressFailed(false);
    setHookStatus("");
    void dispatch({ action: "alert-hook-create" }).then((snap) => {
      const path = snap?.reply?.alertHook?.path;
      if (path) {
        setAddress(`${window.location.origin}${path}`);
        setHookStatus("Webhook address created. Copy it now because it is shown once.");
      }
    });
  };

  /** What a waiting change does, with its check and its way back: short at first when it is long. */
  const approvalBody = (item: InboxItem): JSX.Element | null => {
    const change = changeOf(item);
    if (!item.detail && !change) return null;
    const text = waitingChangeText(item.detail, change);
    const open = !text.long || Boolean(expanded[item.id]);
    return (
      <>
        {item.detail && (
          <pre className="ai-terminal-peek" data-testid={`inbox-change-text-${item.changeId}`}>
            {open ? item.detail : text.peek}
          </pre>
        )}
        {text.fileContent && open && change && (
          <div className="ai-diff">
            <DiffViewer before={change.before ?? ""} after={change.after ?? ""} filePath={change.target} />
          </div>
        )}
        {text.long && (
          <button
            type="button"
            className="ai-mini-btn"
            aria-expanded={open}
            data-testid={`inbox-change-toggle-${item.changeId}`}
            onClick={() => {
              setExpanded((all) => ({ ...all, [item.id]: !open }));
              if (open) setReadFirstId(null);
            }}
          >
            {open
              ? "Show less"
              : text.fileContent
                ? "Show what changes in the file"
                : `Show all ${text.lineCount} lines`}
          </button>
        )}
        {change && <ChangeProof change={change} taskId={item.taskId} />}
      </>
    );
  };

  const actions = (item: InboxItem): JSX.Element => {
    const busy = busyIds.has(item.id);
    const snoozed = isInboxItemSnoozed(item, now);
    const snoozeControls = (
      <div className="ai-inbox-snooze-wrap" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
        {snoozed ? (
          <button
            type="button"
            data-testid={`inbox-unsnooze-btn-${item.id}`}
            onClick={() => void send(item.id, { action: "snooze-inbox", itemId: item.id, until: 0 })}
          >
            Show now
          </button>
        ) : (
          <button
            type="button"
            aria-expanded={snoozeMenuId === item.id}
            data-testid={`inbox-snooze-btn-${item.id}`}
            onClick={() => setSnoozeMenuId((prev) => (prev === item.id ? null : item.id))}
          >
            <Clock size={12} aria-hidden="true" /> Later
          </button>
        )}
        {snoozeMenuId === item.id && !snoozed && (
          <span
            className="ai-inbox-snooze-menu"
            role="group"
            aria-label="Show it again in"
            data-testid={`inbox-snooze-menu-${item.id}`}
            style={{ display: "inline-flex", gap: 4 }}
          >
            <button type="button" onClick={() => snoozeItem(item, "1h")}>
              1h
            </button>
            <button type="button" onClick={() => snoozeItem(item, "4h")}>
              4h
            </button>
            <button type="button" onClick={() => snoozeItem(item, "tomorrow")}>
              Tomorrow
            </button>
          </span>
        )}
      </div>
    );

    switch (item.kind) {
      case "approval": {
        // A setting that needs a token is approved on its own card, where the token is typed.
        const needsSecrets = takesSecrets(changeOf(item));
        return (
          <>
            {needsSecrets ? (
              <small className="ai-hint" data-testid="ai-inbox-takes-secrets">
                {SECRETS_ELSEWHERE}
              </small>
            ) : (
              <button type="button" className="ai-btn-emerald" disabled={busy} onClick={() => approveChange(item)}>
                Approve
              </button>
            )}
            <button
              type="button"
              className="ai-btn-danger"
              disabled={busy}
              onClick={() =>
                void send(item.id, {
                  action: "approve",
                  taskId: item.taskId!,
                  changeId: item.changeId!,
                  approved: false,
                })
              }
            >
              Deny
            </button>
            <button type="button" onClick={() => onOpenTask(item.taskId!)}>
              Open
            </button>
            {readFirstId === item.id && expanded[item.id] && (
              <small className="ai-hint" role="status" data-testid="inbox-read-first">
                This is the whole change. Read it, then press Approve again.
              </small>
            )}
            {(() => {
              // A change that needs two people: who has approved, and that somebody else is being asked.
              const change = changeOf(item);
              const needs = change?.requiredApprovals ?? 1;
              if (change?.adminExceptionAvailable) {
                const reason = exceptionReasons[item.id] ?? "";
                return <label>Reason for approving alone
                  <input value={reason} maxLength={1000} onChange={(event) => setExceptionReasons({ ...exceptionReasons, [item.id]: event.target.value })} />
                  <button type="button" disabled={busy || !reason.trim()} onClick={() => approveChange(item, { adminException: true, note: reason.trim() })}>Approve this change alone</button>
                </label>;
              }
              if (needs < 2) return null;
              const by = (change?.approvals ?? []).filter((a) => a.allowed).map((a) => a.actor);
              return (
                <small className="ai-muted" data-testid={`approval-count-${item.changeId}`}>
                  {by.length > 0
                    ? `Approved so far by ${by.join(", ")}. ${needs} different people have to approve: the others who may are asked in their inbox.`
                    : `${needs} different people have to approve. Your approval counts as one; the others who may are asked in their inbox.`}
                </small>
              );
            })()}
            {snoozeControls}
          </>
        );
      }
      case "peer": {
        // Another member's change: the answer goes to their run, and counts as this member's.
        const waiting = hub.peerApprovals?.find((p) => p.ownerId === item.ownerId && p.changeId === item.changeId);
        const answer = (approved: boolean): void =>
          void send(item.id, { action: "peer-approve", ownerId: item.ownerId!, taskId: item.taskId!, changeId: item.changeId!, approved });
        return (
          <>
            <button type="button" className="ai-btn-emerald" disabled={busy} data-testid={`peer-approve-${item.changeId}`} onClick={() => answer(true)}>
              {waiting?.plan ? "Approve the plan" : "Approve"}
            </button>
            <button type="button" className="ai-btn-danger" disabled={busy} data-testid={`peer-deny-${item.changeId}`} onClick={() => answer(false)}>
              {waiting?.plan ? "Do not approve" : "Deny"}
            </button>
            {waiting && (
              <small className="ai-muted" data-testid={`peer-count-${item.changeId}`}>
                {waiting.approvedBy.length > 0
                  ? `Approved so far by ${waiting.approvedBy.join(", ")}. ${waiting.requiredApprovals} different people have to approve.`
                  : `${waiting.requiredApprovals} different people have to approve. Nobody has yet.`}
              </small>
            )}
            {snoozeControls}
          </>
        );
      }
      case "plan": {
        // Where a plan takes two people, this person's own approval is given once: after that it waits for somebody else.
        const plan = hub.tasks.find((t) => t.id === item.taskId)?.plan;
        const gaveMine = (plan?.requiredApprovals ?? 1) > 1 && (plan?.approvals ?? []).some((a) => a.allowed && !a.peer);
        return (
          <>
            {!gaveMine && (
              <button
                type="button"
                className="ai-btn-emerald"
                disabled={busy}
                onClick={() => void send(item.id, { action: "plan-decide", taskId: item.taskId!, approved: true })}
              >
                Approve the plan
              </button>
            )}
            <button type="button" onClick={() => onOpenTask(item.taskId!)}>
              Read it
            </button>
            {snoozeControls}
          </>
        );
      }
      case "question":
        return (
          <>
            <button type="button" className="ai-btn-accent" onClick={() => onOpenTask(item.taskId!)}>
              Answer
            </button>
            {snoozeControls}
          </>
        );
      case "review":
      case "blocked":
        return (
          <>
            <input
              aria-label="Note for the agent"
              placeholder={item.kind === "review" ? "Note (needed to send it back)" : "Note for the next try"}
              value={note(item.id)}
              onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })}
            />
            <button
              type="button"
              className="ai-btn-emerald"
              disabled={busy}
              onClick={() =>
                void send(item.id, {
                  action: "ticket-review",
                  id: item.ticketId!,
                  approve: true,
                  note: note(item.id),
                })
              }
            >
              {item.kind === "review" ? "Approve: done" : "Mark done"}
            </button>
            <button
              type="button"
              disabled={busy || (item.kind === "review" && !note(item.id).trim())}
              onClick={() =>
                void send(item.id, {
                  action: "ticket-review",
                  id: item.ticketId!,
                  approve: false,
                  note: note(item.id),
                })
              }
            >
              {item.kind === "review" ? "Send back" : "Try again"}
            </button>
            {item.taskId && hub.tasks.some((t) => t.id === item.taskId) && (
              <button type="button" onClick={() => onOpenTask(item.taskId!)}>
                Open
              </button>
            )}
            {item.ticketId && onOpenTicket && (
              <button type="button" onClick={() => onOpenTicket(item.ticketId!)}>
                Open ticket
              </button>
            )}
            {snoozeControls}
          </>
        );
      case "alert": {
        // An alert that has an agent needs no assigning: the button leads to its ticket.
        const hasAgent = Boolean((hub.workTickets ?? []).find((t) => t.id === item.ticketId)?.assigneeAgentId);
        const open = (): void =>
          item.ticketId && onOpenTicket ? onOpenTicket(item.ticketId) : onOpenView("Workforce");
        return (
          <>
            <button type="button" className="ai-btn-accent" onClick={open}>
              {item.ticketId && onOpenTicket && hasAgent ? "Open ticket" : "Assign it"}
            </button>
            {!item.acknowledgedAt && (
              <button
                type="button"
                data-testid={`inbox-ack-btn-${item.id}`}
                onClick={() => void send(item.id, { action: "ack-inbox", itemId: item.id, acknowledged: true })}
              >
                Acknowledge
              </button>
            )}
            {snoozeControls}
          </>
        );
      }
      case "health":
        return (
          <>
            <button type="button" onClick={() => onOpenView("Infrastructure")}>
              Look at the server
            </button>
            <button
              type="button"
              onClick={() => void send(item.id, { action: "facts-problem-dismiss", serverId: item.serverId! })}
            >
              Dismiss
            </button>
            {snoozeControls}
          </>
        );
      case "knowledge":
        return (
          <>
            <button type="button" onClick={() => onOpenView("Knowledge Base", { kbTab: "review" })}>
              Look at it
            </button>
            <button
              type="button"
              onClick={() => void send(item.id, { action: "kb-finding-dismiss", id: item.findingId! })}
            >
              Dismiss
            </button>
            {snoozeControls}
          </>
        );
      case "report":
        return (
          <>
            <button type="button" onClick={() => void send(item.id, { action: "daily-report-read" })}>
              Mark read
            </button>
            {snoozeControls}
          </>
        );
    }
  };

  return (
    // It takes the focus on a click anywhere in it, so the keys work after the person points at the Inbox.
    <div className="ai-scroll ai-inbox-view" data-testid="inbox-view" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="ai-view-head">
        <div className="ai-card-head">
          <h2>Inbox</h2>
          <button
            type="button"
            aria-expanded={showShortcuts}
            data-testid="inbox-shortcuts-toggle"
            onClick={() => setShowShortcuts((open) => !open)}
          >
            <HelpCircle size={13} aria-hidden="true" /> Shortcuts (?)
          </button>
        </div>
        <p className="ai-hint">
          Everything that is waiting for you: commands agents want to run, plans, questions, finished tickets, runs
          that stopped, alerts nobody has. What blocks a running agent comes first.
        </p>
      </header>

      {showShortcuts && (
        <section
          className="ai-card ai-inbox-shortcuts"
          data-testid="inbox-shortcuts"
          aria-label="Inbox keyboard shortcuts"
        >
          <strong>Keyboard shortcuts</strong>
          <p className="ai-hint">
            The keys work while the Inbox has the focus: click in the Inbox or move to it with Tab. Choose an item
            with <kbd>j</kbd> or <kbd>k</kbd> first. The other keys answer the chosen item only.
          </p>
          <div className="ai-inbox-shortcut-grid" style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px", marginTop: 6 }}>
            <span><kbd>j</kbd> / <kbd>k</kbd> Next, previous</span>
            <span><kbd>o</kbd> / <kbd>Enter</kbd> Open</span>
            <span><kbd>a</kbd> Approve (a long change opens first; press again to approve)</span>
            <span><kbd>e</kbd> Acknowledge, or mark a ticket done (press twice)</span>
            <span><kbd>h</kbd> Later</span>
            <span><kbd>?</kbd> Show or hide this list</span>
          </div>
        </section>
      )}

      {allItems.length > 0 && (
        <div className="ai-inbox-toolbar" data-testid="inbox-toolbar" style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "1 1 200px" }}>
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                aria-label="Filter inbox"
                data-testid="inbox-search"
                placeholder="Filter inbox…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="ai-filter-pills" role="group" aria-label="Filter by priority" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(
                [
                  { id: "all", label: "All", count: bucketCounts.all },
                  { id: "blocking", label: "Needs Decision", count: bucketCounts.blocking },
                  { id: "incident", label: "Urgent Alerts", count: bucketCounts.incident },
                  { id: "review", label: "Findings & Suggestions", count: bucketCounts.review },
                  ...(bucketCounts.snoozed > 0
                    ? [{ id: "snoozed" as const, label: "Later", count: bucketCounts.snoozed }]
                    : []),
                ] as Array<{ id: InboxSectionFilter; label: string; count: number }>
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  aria-pressed={sectionFilter === tab.id}
                  className={sectionFilter === tab.id ? "ai-btn-accent" : undefined}
                  data-testid={`inbox-filter-${tab.id}`}
                  onClick={() => setSectionFilter(tab.id)}
                >
                  {tab.label} <span className={TABULAR_NUMS_CLASS} style={TABULAR_NUMS_STYLE}>({tab.count})</span>
                </button>
              ))}
            </div>
          </div>

        </div>
      )}

      {focusItemId && !focusPresent && (
        <p className="ai-note" role="status" data-testid="inbox-handled">
          What that notification was about no longer waits: it has been answered, or the agent stopped waiting.
        </p>
      )}
      {armedDoneId && (
        <p className="ai-note" role="status" data-testid="inbox-done-arm">
          Press <kbd>e</kbd> again to mark it done, or <kbd>Esc</kbd> to cancel.
        </p>
      )}
      {chatWaiting.length > 0 && (
        // The chat agent's changes and plans have no owner, so they are in nobody's Inbox items: the ones this
        // person may answer are listed here, as under Settings, Agent in chat.
        <section className="ai-card" data-testid="inbox-chat-waiting" style={{ marginBottom: 12 }}>
          <p className="ai-hint">
            {chatWaiting.length === 1 ? "1 change from chat waits" : `${chatWaiting.length} changes from chat wait`} for your
            answer. You can answer here, without a linked chat account.
          </p>
          <ChatWaitingList items={chatWaiting} act={dispatch} admin={Boolean(hub.chatAnswering?.admin)} />
        </section>
      )}
      {allItems.length === 0 && chatWaiting.length === 0 && (
        <p className="ai-empty" data-testid="inbox-empty">
          Nothing is waiting for you.
        </p>
      )}
      {allItems.length > 0 && visibleItems.length === 0 && (
        <div className="ai-empty" data-testid="inbox-no-matches">
          <p>No inbox items match your filter.</p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSectionFilter("all");
            }}
          >
            Clear filters
          </button>
        </div>
      )}

      <div className="ai-inbox-list" data-testid="inbox-list">
        {sectionsToRender.map(({ spec, items }) => (
          <section key={spec.id} className="ai-inbox-section" data-testid={spec.testId}>
            <h3 className="ai-inbox-section-title" style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0" }}>
              <span>{spec.title}</span>
              <span className={`ai-badge ${TABULAR_NUMS_CLASS}`} style={TABULAR_NUMS_STYLE}>
                {items.length}
              </span>
            </h3>
            <div className="ai-inbox-list">
              {items.map((item) => {
                const isSelected = selectedId === item.id;
                const snoozed = isInboxItemSnoozed(item, now);
                const bucket = item.bucket ?? inboxPriorityBucket(item.kind);
                return (
                  <article
                    key={item.id}
                    ref={(el) => {
                      itemRefs.current[item.id] = el;
                      if (item.id === focusItemId) focused.current = el;
                    }}
                    data-bucket={bucket}
                    data-selected={isSelected ? "true" : undefined}
                    className={`ai-card ai-inbox-item ${KIND[item.kind].tone}${item.id === focusItemId ? " ai-inbox-focus" : ""}${isSelected ? " ai-inbox-selected" : ""}`}
                    data-testid={`inbox-${item.kind}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <div className="ai-card-head">
                      <div>
                        <small className="ai-inbox-kind">
                          {KIND[item.kind].label}
                          {item.from ? ` · ${item.from}` : ""}
                          {item.target && !item.from?.includes(item.target) ? ` · ${item.target}` : ""} · {ago(item.at)}
                        </small>
                        <strong>{item.title}</strong>
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        {snoozed && (
                          <span
                            className={`ai-badge ai-badge-mode ${TABULAR_NUMS_CLASS}`}
                            style={TABULAR_NUMS_STYLE}
                            data-testid="inbox-snooze-countdown"
                          >
                            {formatSnoozeCountdown(item.snoozedUntil, now)}
                          </span>
                        )}
                        {item.acknowledgedAt && !snoozed && (
                          <span className="ai-badge" data-testid="inbox-ack-badge">
                            Acknowledged
                          </span>
                        )}
                        {/* An alert's or a health finding's severity. An approval carries no rating. */}
                        {item.risk && (
                          <span className={`ai-badge ${item.risk === "critical" ? "ai-badge-danger" : "ai-badge-mode"}`}>
                            {item.risk}
                          </span>
                        )}
                      </div>
                    </div>
                    {item.kind === "peer" && item.detail ? (
                      <pre className="ai-terminal-peek">{item.detail}</pre>
                    ) : item.kind === "approval" ? (
                      approvalBody(item)
                    ) : item.kind === "report" && hub.dailyReport ? (
                      <div className="ai-doc-body">
                        <RichMarkdownContent text={hub.dailyReport.text} />
                      </div>
                    ) : item.detail ? (
                      <div className="ai-doc-excerpt">
                        <RichMarkdownContent text={item.detail} />
                      </div>
                    ) : null}
                    <div className="ai-card-actions">{actions(item)}</div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <details className="ai-fold ai-set-fold" data-testid="alerts-in">
        <summary>
          Alerts in
          {intake?.enabled
            ? ` · on, ${intake.received} webhook alert${intake.received === 1 ? "" : "s"} received${
                intake.lastAt ? ` (last ${ago(intake.lastAt)})` : ""
              }`
            : " · no address for your monitoring yet"}
        </summary>
        <div className="ai-form">
          <p className="ai-hint">
            An alert becomes a ticket on the board: the same alert firing again is counted on its ticket, and with the
            heartbeat on an agent starts looking before anyone is awake. The alert&apos;s text is given to the agent
            as data, never as an instruction. The counter tracks alerts posted to the webhook address below; pasted
            and demo alerts create tickets directly.
          </p>
          {intake?.canReceive ? (
            <>
              <div className="ai-card-actions">
                {intake.enabled ? (
                  // The old address stops working at once: whatever posts to it has to be given the new one.
                  <ConfirmButton
                    label="Replace the address"
                    confirmLabel="Replace it? The old address stops working."
                    className="ai-btn-accent"
                    onConfirm={createAlertAddress}
                  />
                ) : (
                  <button type="button" className="ai-btn-accent" onClick={createAlertAddress}>
                    Create an address to post to
                  </button>
                )}
                {intake.enabled && (
                  <ConfirmButton
                    label="Revoke and turn off"
                    confirmLabel="Turn it off? The address stops working."
                    className=""
                    onConfirm={() => {
                      setHookStatus("");
                      void dispatch({ action: "alert-hook-disable" }).then((snap) => {
                        setAddress("");
                        setCopiedAddress(false);
                        setCopyAddressFailed(false);
                        const notes = snap?.reply?.notes?.join(" ");
                        setHookStatus(notes || "Webhook address revoked and turned off.");
                      });
                    }}
                  />
                )}
              </div>
              {hookStatus && (
                <p className="ai-hint" role="status" data-testid="alert-hook-status">
                  {hookStatus}
                </p>
              )}
              {intake.enabled && !address && (
                <p className="ai-hint">
                  Active. The webhook address is shown once when created; click Replace the address to generate a new one.
                </p>
              )}
              {address && (
                <label>
                  Post alerts here (Alertmanager webhook, Grafana contact point, PagerDuty webhook, or any JSON). Shown
                  once: it is the key.
                  <div className="ai-inline-form">
                    <input
                      readOnly
                      className="ai-mono"
                      data-testid="alert-address"
                      value={address}
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      data-testid="alert-address-copy"
                      onClick={() => {
                        setCopyAddressFailed(false);
                        void copyToClipboard(address).then((ok) => {
                          if (ok) {
                            setCopiedAddress(true);
                            window.setTimeout(() => setCopiedAddress(false), 2000);
                          } else {
                            setCopiedAddress(false);
                            setCopyAddressFailed(true);
                            window.setTimeout(() => setCopyAddressFailed(false), 4000);
                          }
                        });
                      }}
                    >
                      {copiedAddress ? "Copied" : "Copy address"}
                    </button>
                  </div>
                  {copyAddressFailed && (
                    <small role="status" data-testid="alert-address-copy-error" className="ai-warn">
                      Could not copy automatically. Select and copy the text.
                    </small>
                  )}
                </label>
              )}
            </>
          ) : (
            <p className="ai-hint">
              The desktop app has no address a monitoring system can reach. To receive alerts, run sshS3 as a
              server. Here you can paste one.
            </p>
          )}
          <fieldset className="ai-checks ai-alert-rules">
            <legend>
              Who gets which alert (first match wins; otherwise the agent bound to the cluster, then a team&apos;s lead)
            </legend>
            {shownRules.map((rule, i) => (
              <div key={i} className="ai-inline-form">
                <input
                  aria-label="Alert contains"
                  placeholder="disk, postgres, DB-Prod…"
                  value={rule.match}
                  onChange={(e) => {
                    setRuleNotice(undefined);
                    setRules(shownRules.map((r, j) => (j === i ? { ...r, match: e.target.value } : r)));
                  }}
                />
                <select
                  aria-label="Goes to"
                  value={rule.agentId}
                  onChange={(e) => {
                    setRuleNotice(undefined);
                    setRules(shownRules.map((r, j) => (j === i ? { ...r, agentId: e.target.value } : r)));
                  }}
                >
                  <option value="">Choose an agent</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    setRuleNotice(undefined);
                    setRules(shownRules.filter((_, j) => j !== i));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            {ruleNotice && (
              <p
                className={ruleNotice.isError ? "ai-error" : "ai-hint"}
                role={ruleNotice.isError ? "alert" : "status"}
                data-testid="alert-rules-status"
              >
                {ruleNotice.text}
              </p>
            )}
            <div className="ai-card-actions">
              <button
                type="button"
                onClick={() => {
                  setRuleNotice(undefined);
                  setRules([...shownRules, { match: "", agentId: "" }]);
                }}
              >
                Add a rule
              </button>
              {rules && (
                <button
                  type="button"
                  className="ai-btn-emerald"
                  onClick={() => {
                    setRuleNotice(undefined);
                    void dispatch({ action: "alert-rules-save", rules })
                      .then((snap) => {
                        const notes = snap?.reply?.notes ?? [];
                        const rejected = notes.some((n) => n.startsWith("Not saved"));
                        if (snap && !rejected) {
                          setRules(undefined);
                          setRuleNotice({ text: notes.join(" ") || "Rules saved.", isError: false });
                        } else if (notes.length > 0) {
                          setRuleNotice({ text: notes.join(" "), isError: true });
                        }
                      })
                      .catch((err) => {
                        setRuleNotice({
                          text: err instanceof Error ? err.message : "Could not save rules.",
                          isError: true,
                        });
                      });
                  }}
                >
                  Save rules
                </button>
              )}
            </div>
          </fieldset>
          <label>
            Paste an alert (the JSON a monitoring system would post, or just its text)
            <textarea rows={3} data-testid="alert-paste" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          </label>
          <div className="ai-card-actions">
            <button
              type="button"
              disabled={!pasted.trim()}
              onClick={() => void dispatch({ action: "alert-paste", text: pasted }).then((snap) => snap && setPasted(""))}
            >
              Make a ticket of it
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}
