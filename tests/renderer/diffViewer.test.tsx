// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AnsiLogView,
  DiffViewer,
  HighlightedCode,
  parseAnsiLines,
  stripAnsiAndNormalize,
} from "../../src/renderer/src/components/AiHub/DiffViewer";
import { ConfirmButton } from "../../src/renderer/src/components/AiHub/ConfirmButton";
import {
  ALL_HUB_VIEWS,
  CANONICAL_VIEW_LABELS,
  CORE_VIEWS,
  DEMO_MODE_SET_BY_SERVER,
  LABS_VIEWS,
  formatCompactTokens,
  formatTokenUsage,
  formatUsdCost,
  getHubViewLabel,
  getVisibleHubViews,
  isCoreView,
  isLabsView,
  modes,
} from "../../src/renderer/src/components/AiHub/panelShared";
import {
  decodeFileRefHref,
  encodeFileRefHref,
  extractFileRefs,
  linkFileRefs,
  linkRefs,
  linkReportRefs,
  parseFileRef,
  tokenizeReportRefs,
} from "../../src/renderer/src/components/AiHub/reportRefs";

describe("DiffViewer", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders unified diff hunks with dual line numbers and file header", () => {
    const patch = [
      "--- a/etc/multipath.conf",
      "+++ b/etc/multipath.conf",
      "@@ -7,3 +7,3 @@",
      "     device {",
      "-        path_grouping_policy group_by_prio",
      "+        path_grouping_policy multibus",
      "     }",
    ].join("\n");

    const { container } = render(<DiffViewer diff={patch} />);
    expect(screen.getByText("etc/multipath.conf")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument();
    expect(screen.getByText("-1")).toBeInTheDocument();
    expect(container.querySelector(".ai-diff-line-hunk")).toHaveTextContent("@@ -7,3 +7,3 @@");
    expect(container.querySelector(".ai-diff-line-del")).toBeInTheDocument();
    expect(container.querySelector(".ai-diff-line-add")).toBeInTheDocument();
    expect(container.querySelector(".ai-diff-word-del")).toHaveTextContent("group_by_prio");
    expect(container.querySelector(".ai-diff-word-add")).toHaveTextContent("multibus");
    expect(container.querySelector(".ai-diff-ln-old")).toHaveTextContent("7");
    expect(container.querySelector(".ai-diff-ln-new")).toHaveTextContent("7");
  });

  it("computes before/after diffs, collapses unchanged context, and expands on click", () => {
    const beforeLines = Array.from({ length: 18 }, (_, i) => `line ${i + 1}`);
    const afterLines = [...beforeLines];
    afterLines[15] = "line 16 updated";

    const { container } = render(
      <DiffViewer
        before={beforeLines.join("\n")}
        after={afterLines.join("\n")}
        filePath="/etc/config.yml"
        maxUnchangedCollapsed={4}
      />,
    );

    expect(screen.getByText("/etc/config.yml")).toBeInTheDocument();
    const expandBtn = screen.getByRole("button", { name: /Show \d+ unchanged lines?/i });
    expect(expandBtn).toBeInTheDocument();
    expect(screen.queryByText("line 1")).not.toBeInTheDocument();

    fireEvent.click(expandBtn);
    expect(screen.getByText("line 1")).toBeInTheDocument();
    expect(container.querySelector(".ai-diff-word-add")).toHaveTextContent("updated");
  });

  it("switches between unified and split view modes", () => {
    const { container } = render(
      <DiffViewer
        before={"alpha\nbeta\ngamma"}
        after={"alpha\nbeta-2\ngamma"}
        defaultMode="unified"
      />,
    );

    expect(container.querySelector(".ai-diff-unified")).toBeInTheDocument();
    const splitBtn = screen.getByRole("button", { name: "Split" });
    fireEvent.click(splitBtn);
    expect(splitBtn).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".ai-diff-split")).toBeInTheDocument();
    expect(container.querySelectorAll(".ai-diff-split-row").length).toBeGreaterThanOrEqual(3);
  });

  it("shows No changes when before and after are identical", () => {
    render(<DiffViewer before="same" after="same" />);
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });
});

describe("AnsiLogView and HighlightedCode", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("parses ANSI SGR colors and normalizes carriage-return spinner frames without leaking escapes", () => {
    const raw =
      "\x1b[33mDownloading 10%\r\x1b[33mDownloading 50%\r\x1b[1;32mDone\x1b[0m\n" +
      "\x1b[31mERROR: disk full\x1b[0m\n" +
      "\x1b[90mtrace\x1b[0m \x1b[36minfo\x1b[0m \x1b[34mblue\x1b[0m";

    const lines = parseAnsiLines(raw);
    expect(lines.map((l) => l.plainText)).toEqual([
      "Done",
      "ERROR: disk full",
      "trace info blue",
    ]);
    expect(stripAnsiAndNormalize(raw)).toBe("Done\nERROR: disk full\ntrace info blue");

    const { container } = render(<AnsiLogView text={raw} highlightErrors />);
    expect(container.textContent).not.toContain("\x1b");
    expect(container.textContent).not.toContain("Downloading");
    expect(container.querySelector(".ai-ansi-fg-green.ai-ansi-bold")).toHaveTextContent("Done");
    expect(container.querySelector(".ai-ansi-line-error")).toBeInTheDocument();
    expect(container.querySelector(".ai-ansi-fg-gray")).toHaveTextContent("trace");
    expect(container.querySelector(".ai-ansi-fg-cyan")).toHaveTextContent("info");
    expect(container.querySelector(".ai-ansi-fg-blue")).toHaveTextContent("blue");
  });

  it("collapses long logs with head+tail and copies clean normalized text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const rawLines = Array.from({ length: 20 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`);
    rawLines[0] = "spin1\r\x1b[32mline 1\x1b[0m";

    render(<AnsiLogView text={rawLines.join("\n")} maxLines={6} highlightErrors={false} />);

    expect(screen.getByText("line 1")).toBeInTheDocument();
    expect(screen.getByText("line 20")).toBeInTheDocument();
    expect(screen.queryByText("line 10")).not.toBeInTheDocument();

    const showAllBtn = screen.getByRole("button", { name: /Show all 20 lines/i });
    fireEvent.click(showAllBtn);
    expect(screen.getByText("line 10")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).not.toContain("\x1b");
    expect(copied).not.toContain("spin1");
    expect(copied.split("\n")).toHaveLength(20);
  });

  it("wraps Lezer highlightCode cleanly", () => {
    const { container } = render(<HighlightedCode code="const x = 42;" lang="typescript" />);
    expect(container.textContent).toBe("const x = 42;");
    expect(container.querySelector(".tok-keyword")).toHaveTextContent("const");
  });
});

describe("reportRefs extended file/line citations", () => {
  it("keeps existing command ref linking intact", () => {
    expect(linkRefs("See [c1].", new Set(["c1"]))).toBe("See [c1](#ref-c1).");
  });

  it("parses POSIX, remote host, and Windows paths while rejecting timestamps and URLs", () => {
    expect(parseFileRef("prod-web-01:/etc/nginx/nginx.conf:42")).toEqual({
      raw: "prod-web-01:/etc/nginx/nginx.conf:42",
      host: "prod-web-01",
      path: "/etc/nginx/nginx.conf",
      line: 42,
      column: undefined,
    });
    expect(parseFileRef("ops@db-01:/var/log/postgresql.log:10:5")).toEqual({
      raw: "ops@db-01:/var/log/postgresql.log:10:5",
      host: "ops@db-01",
      path: "/var/log/postgresql.log",
      line: 10,
      column: 5,
    });
    expect(parseFileRef("/etc/multipath.conf:12")).toEqual({
      raw: "/etc/multipath.conf:12",
      path: "/etc/multipath.conf",
      line: 12,
      column: undefined,
    });
    expect(parseFileRef("C:\\Users\\jacob\\app.ts:99")).toEqual({
      raw: "C:\\Users\\jacob\\app.ts:99",
      path: "C:\\Users\\jacob\\app.ts",
      line: 99,
      column: undefined,
    });

    expect(parseFileRef("2026-11-14:00")).toBeNull();
    expect(parseFileRef("12:34:56")).toBeNull();
    expect(parseFileRef("https://example.com/etc/hosts:80")).toBeNull();
    expect(parseFileRef("s3://bucket/path/file.json")).toBeNull();
    expect(parseFileRef("src/renderer/App.tsx")).toBeNull();
  });

  it("tokenizes mixed prose into cmd, file, and text segments losslessly", () => {
    const input =
      "Check [c2] at prod-01:/etc/nginx/nginx.conf:42, /var/log/syslog:10, and C:\\app\\main.ts:5 at 2026-11-14:00 vs https://example.com/etc/hosts and foo/bar/baz.";
    const segments = tokenizeReportRefs(input, new Set(["c2"]));
    expect(segments.map((s) => s.text).join("")).toBe(input);

    const cmds = segments.filter((s) => s.kind === "cmd");
    const files = segments.filter((s) => s.kind === "file");
    expect(cmds).toHaveLength(1);
    expect(files.map((f) => f.kind === "file" && f.fileRef.raw)).toEqual([
      "prod-01:/etc/nginx/nginx.conf:42",
      "/var/log/syslog:10",
      "C:\\app\\main.ts:5",
    ]);

    const extracted = extractFileRefs(
      "Look at `/etc/multipath.conf` and\n```\n/ignored/in/fence.txt\n```\n",
    );
    expect(extracted.map((r) => r.path)).toEqual(["/etc/multipath.conf"]);

    const linked = linkReportRefs("See [c2] and /etc/hosts.", new Set(["c2"]));
    expect(linked).toBe("See [c2](#ref-c2) and [/etc/hosts](#file-%2Fetc%2Fhosts).");
    expect(linkFileRefs("```\n/etc/hosts\n```")).toBe("```\n/etc/hosts\n```");

    const ref = parseFileRef("prod-01:/etc/hosts:7")!;
    expect(decodeFileRefHref(encodeFileRefHref(ref))).toEqual(ref);
  });
});

describe("panelShared helpers", () => {
  it("preserves existing exports and provides canonical labels, progressive disclosure, and token formatting", () => {
    expect(DEMO_MODE_SET_BY_SERVER).toContain("Demo mode");
    expect(modes.assisted).toBe("Ask first");

    expect(ALL_HUB_VIEWS).toHaveLength(9);
    expect(CORE_VIEWS.every((v) => isCoreView(v) && !isLabsView(v))).toBe(true);
    expect(LABS_VIEWS.every((v) => isLabsView(v) && !isCoreView(v))).toBe(true);
    expect(getVisibleHubViews(false)).toEqual(CORE_VIEWS);
    expect(getVisibleHubViews(true)).toEqual(ALL_HUB_VIEWS);

    expect(Object.values(CANONICAL_VIEW_LABELS)).toEqual([
      "Chat",
      "Inbox",
      "Workforce",
      "Infrastructure",
      "Knowledge Base",
      "Changes",
      "Memory & skills",
      "Agents & MCP",
      "Schedules",
    ]);
    expect(getHubViewLabel("Work")).toBe("Chat");
    expect(getHubViewLabel("Knowledge Base", { compact: true })).toBe("Runbooks");

    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(850)).toBe("850");
    expect(formatCompactTokens(1250)).toBe("1.3k");
    expect(formatCompactTokens(128000)).toBe("128k");
    expect(formatCompactTokens(1500000)).toBe("1.5M");

    expect(formatUsdCost(undefined)).toBe("");
    expect(formatUsdCost(0)).toBe("$0.00");
    expect(formatUsdCost(0.0004)).toBe("<$0.001");
    expect(formatUsdCost(0.012)).toBe("$0.012");
    expect(formatUsdCost(1.5)).toBe("$1.50");
    expect(formatTokenUsage(1000, 500, 0.015)).toBe("1.5k · $0.015");
  });
});

describe("ConfirmButton accessibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("announces confirm state via aria-live, cancels on Escape, and renders shortcutHint", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        label="Delete"
        confirmLabel="Confirm delete?"
        onConfirm={onConfirm}
        shortcutHint="Del"
      />,
    );

    expect(screen.getByText("Del")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(btn);

    expect(screen.getByRole("button", { name: "Confirm delete?" })).toHaveClass("ai-btn-confirming");
    expect(screen.getByRole("status")).toHaveTextContent("Confirm delete?. Press Escape to cancel.");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(btn, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Delete" })).not.toHaveClass("ai-btn-confirming");
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete?" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
