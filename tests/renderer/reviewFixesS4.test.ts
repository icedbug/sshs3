import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openableLocalFileRef } from "../../src/renderer/src/components/AiHub/reportRefs";

describe("opening a file citation", () => {
  it("opens a reference without a host on this computer", () => {
    expect(openableLocalFileRef({ raw: "/etc/hosts:3", path: "/etc/hosts", line: 3 })).toEqual({ path: "/etc/hosts" });
  });

  it("refuses a reference to another server's file instead of opening this computer's file of that name", () => {
    const r = openableLocalFileRef({ raw: "prod-01:/etc/shadow", host: "prod-01", path: "/etc/shadow" });
    expect(r).not.toHaveProperty("path");
    expect((r as { refused: string }).refused).toMatch(/file on prod-01, not on this computer/);
  });
});

describe("AI hub stylesheet", () => {
  const dir = path.join(__dirname, "../../src/renderer/src/components/AiHub");
  const css = [path.join(dir, "aiHub.css"), path.join(__dirname, "../../src/renderer/src/index.css")]
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n");
  const styled = new Set([...css.matchAll(/\.(ai-[a-zA-Z0-9_-]+)/g)].map((m) => m[1]));

  /** The text of every className attribute: a string, or an expression in braces. */
  function classNameExpressions(src: string): string[] {
    const out: string[] = [];
    let i = 0;
    while ((i = src.indexOf("className=", i)) !== -1) {
      i += "className=".length;
      if (src[i] === '"' || src[i] === "'") {
        const end = src.indexOf(src[i], i + 1);
        out.push(src.slice(i + 1, end));
        i = end;
      } else if (src[i] === "{") {
        let depth = 0;
        let j = i;
        for (; j < src.length; j++) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}" && --depth === 0) break;
        }
        out.push(src.slice(i + 1, j));
        i = j;
      }
    }
    return out;
  }

  it("has a rule for every ai-* class the views use (or the class sits beside one that has)", () => {
    const missing: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => /\.tsx$/.test(f))) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      for (const expr of classNameExpressions(src)) {
        // Whole names only: `ai-badge-${tone}` is built at run time and checked below where it matters.
        const names = [...expr.matchAll(/(?<![\w$.-])(ai-[a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-]|\$\{)/g)].map((m) => m[1]);
        // A class without a rule of its own is fine as a modifier or hook on an element another ai-* rule styles.
        const anyStyled = names.some((n) => styled.has(n));
        for (const name of names) if (!styled.has(name) && !anyStyled) missing.push(`${file}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("keeps the rules the views relied on before the restyle", () => {
    for (const name of [
      "ai-hub-web",
      "ai-history-new",
      "ai-model-chip",
      "ai-more",
      "ai-page",
      "ai-page-when",
      "ai-audit-seq",
      "ai-audit-text",
      "ai-audit-gaps",
      "ai-link-proposed",
      "ai-alert-rules",
      "ai-recording-mark-past",
      "ai-set-fold",
      "ai-timeline-text",
      "ai-timeline-more",
      "ai-view-tabs",
      "ai-inbox",
      // Built as `ai-inbox-${item.state}` in KnowledgeBaseView.
      "ai-inbox-added",
      "ai-inbox-failed",
    ])
      expect(styled.has(name), name).toBe(true);
  });
});
