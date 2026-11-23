// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "../../src/renderer/src/components/ConfirmDialog";
import { SSHProfileForm } from "../../src/renderer/src/components/ConnectionModal/SSHProfileForm";
import { SSHTunnelsModal } from "../../src/renderer/src/components/SSH/SSHTunnelsModal";
import { TabBar } from "../../src/renderer/src/components/TabBar";
import { DesktopOnly } from "../../src/renderer/src/components/ui/DesktopOnly";
import type { SSHConnectionConfig } from "../../src/shared/types/ssh";

const web = (on: boolean): void => {
  (window as unknown as { __SSHS3_WEB_MODE__?: boolean }).__SSHS3_WEB_MODE__ = on ? true : undefined;
};

beforeEach(() => {
  window.multissh = {
    dotfilePoolsGet: vi.fn().mockResolvedValue([]),
    profilesGet: vi.fn().mockResolvedValue({ ssh: [], s3: [] }),
    smartcardDetect: vi.fn().mockResolvedValue([]),
    selectFile: vi.fn().mockResolvedValue(null),
    sshTunnelList: vi.fn().mockResolvedValue([]),
    onSshTunnelEvent: vi.fn(() => () => undefined),
    sshTunnelStart: vi.fn(),
  } as unknown as typeof window.multissh;
});

afterEach(() => {
  cleanup();
  web(false);
});

const connection: SSHConnectionConfig = { id: "conn-1", name: "Bastion", host: "bastion.example", port: 22, username: "ops", authType: "password", tunnels: [] };

describe("a control that needs the person's own computer", () => {
  it("is drawn as it is in the desktop app", () => {
    const press = vi.fn();
    render(
      <DesktopOnly>
        <button onClick={press}>Start tunnel</button>
      </DesktopOnly>,
    );
    expect(screen.queryByTestId("desktop-only-note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start tunnel" }));
    expect(press).toHaveBeenCalledTimes(1);
  });

  it("is disabled in the browser, with one line that says why", () => {
    web(true);
    const press = vi.fn();
    render(
      <DesktopOnly>
        <button onClick={press}>Start tunnel</button>
        <input aria-label="Local port" />
      </DesktopOnly>,
    );
    expect(screen.getByTestId("desktop-only-note")).toHaveTextContent("Only in the desktop app.");
    expect(screen.getByRole("button", { name: "Start tunnel" })).toBeDisabled();
    expect(screen.getByLabelText("Local port")).toBeDisabled();
    // A browser sends no click to a control in a disabled group. The group takes no pointer at all either.
    expect(screen.getByRole("button", { name: "Start tunnel" }).closest("fieldset")).toHaveClass("pointer-events-none");
    expect(press).not.toHaveBeenCalled();
  });
});

describe("in the browser", () => {
  beforeEach(() => web(true));

  it("the tunnels window says it is for the desktop app, and none of its controls can be pressed", async () => {
    render(
      <ConfirmProvider>
        <SSHTunnelsModal connection={connection} open onClose={vi.fn()} />
      </ConfirmProvider>,
    );
    const group = await screen.findByTestId("desktop-only");
    expect(within(group).getByTestId("desktop-only-note")).toHaveTextContent("Only in the desktop app.");
    const controls = within(group).queryAllByRole("button");
    for (const control of controls) expect(control).toBeDisabled();
    expect(window.multissh.sshTunnelStart).not.toHaveBeenCalled();
  });

  it("the server form does not offer sign-in with a smartcard or a security key", async () => {
    render(<SSHProfileForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const select = screen.getByLabelText(/Authentication/i) as HTMLSelectElement;
    const options = Array.from(select.options);
    const card = options.find((o) => o.value === "smartcard")!;
    const key = options.find((o) => o.value === "fido2")!;
    expect(card).toBeDisabled();
    expect(card).toHaveTextContent("Smartcard (PKCS#11). Only in the desktop app.");
    expect(key).toBeDisabled();
    expect(key).toHaveTextContent("FIDO2 / Security Key. Only in the desktop app.");
    expect(options.find((o) => o.value === "password")).toBeEnabled();
  });

  it("the top bar has no tunnels button when tunnels are not offered", () => {
    render(<TabBar tabs={[]} activeTabId="" onSelectTab={vi.fn()} onCloseTab={vi.fn()} onNewTab={vi.fn()} onOpenProfiles={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.queryByTestId("quick-tunnels-btn")).toBeNull();
  });
});

describe("in the desktop app", () => {
  it("the server form offers every way to sign in, and the top bar has its tunnels button", async () => {
    render(<SSHProfileForm onSave={vi.fn()} onCancel={vi.fn()} />);
    const select = screen.getByLabelText(/Authentication/i) as HTMLSelectElement;
    for (const option of Array.from(select.options)) expect(option).toBeEnabled();
    cleanup();
    render(<TabBar tabs={[]} activeTabId="" onSelectTab={vi.fn()} onCloseTab={vi.fn()} onNewTab={vi.fn()} onOpenProfiles={vi.fn()} onOpenSettings={vi.fn()} onOpenTunnels={vi.fn()} />);
    expect(screen.getByTestId("quick-tunnels-btn")).toBeInTheDocument();
  });
});
