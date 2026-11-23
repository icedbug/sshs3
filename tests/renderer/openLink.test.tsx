// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../../src/renderer/src/components/ConfirmDialog";
import { RichMarkdownContent } from "../../src/renderer/src/components/AiHub/RichMarkdownContent";
import { externalLinkProps, openLink, safeLinkTarget } from "../../src/renderer/src/lib/openLink";
import { useOpenHiddenLink } from "../../src/renderer/src/lib/useOpenHiddenLink";

const openExternal = vi.fn(async (_url: string) => undefined);
const windowOpen = vi.fn();

beforeEach(() => {
  openExternal.mockClear();
  windowOpen.mockClear();
  vi.stubGlobal("open", windowOpen);
  (window as unknown as { multissh: unknown }).multissh = { openExternal };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { multissh?: unknown }).multissh;
  delete (window as unknown as { __SSHS3_WEB_MODE__?: boolean }).__SSHS3_WEB_MODE__;
});

const web = (): void => {
  (window as unknown as { __SSHS3_WEB_MODE__?: boolean }).__SSHS3_WEB_MODE__ = true;
};

describe("safeLinkTarget", () => {
  it("lets web and mail addresses through and nothing else", () => {
    expect(safeLinkTarget("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeLinkTarget(" http://127.0.0.1:8080 ")).toBe("http://127.0.0.1:8080");
    expect(safeLinkTarget("mailto:ops@example.com")).toBe("mailto:ops@example.com");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ssh://host", "data:text/html,x", "/relative", "#top", "", undefined, null]) {
      expect(safeLinkTarget(bad)).toBeUndefined();
    }
  });
});

describe("openLink", () => {
  it("on the desktop hands a web address to the app, which opens the system browser", () => {
    expect(openLink("https://example.com/a")).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("in a browser opens a new tab, and does not ask the server to open anything", () => {
    web();
    expect(openLink("https://example.com/a")).toBe(true);
    expect(windowOpen).toHaveBeenCalledWith("https://example.com/a", "_blank", "noopener,noreferrer");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens a mail address on both", () => {
    expect(openLink("mailto:ops@example.com")).toBe(true);
    expect(windowOpen).toHaveBeenCalledWith("mailto:ops@example.com", "_blank", "noopener,noreferrer");
    web();
    expect(openLink("mailto:ops@example.com")).toBe(true);
    expect(windowOpen).toHaveBeenCalledTimes(2);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens nothing for another kind of address", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "smb://share/x", "relative/path"]) expect(openLink(bad)).toBe(false);
    web();
    expect(openLink("javascript:alert(1)")).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe("a link in an answer of the assistant", () => {
  it("shows where it goes and opens it outside the app, on the desktop", () => {
    render(<RichMarkdownContent text="Read [the guide](https://example.com/guide) first." />);
    const link = screen.getByRole("link", { name: "the guide" });
    expect(link).toHaveAttribute("title", "https://example.com/guide");
    // The page itself does not follow it.
    expect(fireEvent.click(link)).toBe(false);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/guide");
  });

  it("opens in a new tab in a browser", () => {
    web();
    render(<RichMarkdownContent text="Read [the guide](https://example.com/guide) first." />);
    fireEvent.click(screen.getByRole("link", { name: "the guide" }));
    expect(windowOpen).toHaveBeenCalledWith("https://example.com/guide", "_blank", "noopener,noreferrer");
  });

  it("externalLinkProps opens nothing for an address that is not a web or mail address", () => {
    const props = externalLinkProps("/relative/page");
    const preventDefault = vi.fn();
    props.onClick({ preventDefault } as never);
    expect(preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe("a hyperlink a program printed in the terminal", () => {
  function Probe(): JSX.Element {
    const open = useOpenHiddenLink();
    return <button onClick={() => open("https://evil.example/login")}>click here</button>;
  }

  it("shows its address and opens it only after a yes", async () => {
    render(
      <ConfirmProvider>
        <Probe />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "click here" }));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("Open this link?");
    expect(within(dialog).getByTestId("hidden-link-target")).toHaveTextContent("https://evil.example/login");
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect(openExternal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "click here" }));
    fireEvent.click(within(await screen.findByTestId("confirm-dialog")).getByRole("button", { name: "Open link" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://evil.example/login"));
  });

  it("asks with the browser's own question where the app's dialog is not around", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "click here" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("https://evil.example/login"));
    await Promise.resolve();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
