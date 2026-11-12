// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RichMarkdownContent } from "../../src/renderer/src/components/AiHub/RichMarkdownContent";
import { linkRefs } from "../../src/renderer/src/components/AiHub/reportRefs";

describe("references from a report to its commands", () => {
  it("links only the names that exist, and leaves code alone", () => {
    const refs = new Set(["c1", "c3"]);
    expect(linkRefs("The pool is scrubbing [c3].", refs)).toBe("The pool is scrubbing [c3](#ref-c3).");
    expect(linkRefs("Both agree [c1, c3]; unknown [c9]; a link [c1](x)", refs)).toBe(
      "Both agree [c1](#ref-c1) [c3](#ref-c3); unknown [c9]; a link [c1](x)",
    );
    expect(linkRefs("`arr[c1]` and\n```\nx[c3]\n```", refs)).toBe("`arr[c1]` and\n```\nx[c3]\n```");
    expect(linkRefs("[c1]", new Set())).toBe("[c1]");
  });

  it("opens the command when the reference is clicked", () => {
    const open = vi.fn();
    render(<RichMarkdownContent text="Disk is full [c2]. See [the docs](https://example.com)." refs={new Set(["c2"])} onOpenRef={open} />);
    fireEvent.click(screen.getByRole("button", { name: "c2" }));
    expect(open).toHaveBeenCalledWith("c2");
    expect(screen.getByRole("link", { name: "the docs" })).toHaveAttribute("href", "https://example.com");
  });
});
