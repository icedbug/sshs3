// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot, ServerFacts } from "../../src/shared/types/aiHub";
import { ServerFactsCard } from "../../src/renderer/src/components/AiHub/ServerFactsCard";

afterEach(cleanup);
const NOW = Date.now();
const hub = (facts: Partial<NonNullable<HubSnapshot["serverFacts"]>> = {}): HubSnapshot =>
  ({
    tasks: [],
    serverFacts: {
      enabled: true,
      intervalHours: 6,
      exclude: ["nas"],
      watchPaths: [],
      collecting: [],
      servers: [
        { serverId: "web", name: "web-01", status: "ok", collectedAt: NOW - 20 * 60_000, via: "open-tab", os: "Debian GNU/Linux 12", kernel: "Linux 6.1", packages: 412, services: 23, listening: 5, bootAt: NOW - 3 * 3_600_000, rebootRequired: true, disks: [{ mount: "/", usedPct: 94 }, { mount: "/var", usedPct: 40 }], problems: [{ kind: "disk", key: "disk:/", severity: "warning", text: "Disk / is 94 % full" }], changes: [{ at: NOW - 20 * 60_000, kind: "package", text: "Package nginx 1.24.0-2 → 1.26.1-1" }] },
        { serverId: "db", name: "pg-01", status: "failed", error: "Permission denied (publickey)", problems: [], changes: [] },
        { serverId: "nas", name: "netapp-01", status: "unsupported", problems: [], changes: [] },
      ],
      ...facts,
    },
  }) as unknown as HubSnapshot;

describe("server facts", () => {
  it("is off until switched on, and says what switching on does", () => {
    const act = vi.fn(async () => hub());
    render(<ServerFactsCard hub={hub({ enabled: false })} act={act} />);
    expect(screen.queryByText("Changed recently")).not.toBeInTheDocument();
    expect(screen.getByText(/asks for a password, a smartcard or a touch is read only while its terminal is open/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Read facts from the servers"));
    expect(act).toHaveBeenCalledWith({ action: "facts-configure", enabled: true });
  });

  it("shows each server, what changed and what needs attention, and opens the details", async () => {
    const facts = { collectedAt: NOW, failedServices: ["backup"], runningServices: ["nginx"], listening: [{ proto: "tcp", address: "0.0.0.0", port: 443, process: "nginx" }], peers: [], disks: [], certs: [{ path: "/etc/ssl/a.pem", notAfter: Date.UTC(2027, 0, 5) }], files: { "/etc/hosts": "a".repeat(64), "/etc/sudoers": "unreadable" }, packages: { nginx: "1" }, packageManager: "dpkg" } as ServerFacts;
    const act = vi.fn(async (request: HubRequest) => ({ ...hub(), reply: request.action === "server-facts-read" ? { serverFacts: { serverId: "web", facts, changes: [{ at: NOW, kind: "file", text: "/etc/hosts changed" }] } } : undefined }) as HubSnapshot);
    render(<ServerFactsCard hub={hub()} act={act} />);
    expect(within(screen.getByTestId("facts-recent")).getByText("web-01")).toBeInTheDocument();
    expect(screen.getByTestId("facts-recent")).toHaveTextContent("Package nginx 1.24.0-2 → 1.26.1-1");

    const web = screen.getByTestId("facts-server-web");
    expect(web).toHaveTextContent("Debian GNU/Linux 12 · Linux 6.1");
    expect(web).toHaveTextContent("412 packages · 23 services · 5 listening");
    expect(web).toHaveTextContent("restart required");
    expect(web).toHaveTextContent("over the open terminal's connection");
    expect(web).toHaveTextContent("Disk / is 94 % full");
    expect(web).toHaveTextContent("/var 40 %");
    expect(screen.getByTestId("facts-server-db")).toHaveTextContent("Could not be readPermission denied (publickey)");
    expect(screen.getByTestId("facts-server-nas")).toHaveTextContent("left alone");

    fireEvent.click(within(web).getByRole("button", { name: "Details" }));
    expect(act).toHaveBeenCalledWith({ action: "server-facts-read", serverId: "web" });
    await waitFor(() => expect(web).toHaveTextContent("/etc/hosts changed"));
    expect(web).toHaveTextContent("tcp/443 nginx");
    expect(web).toHaveTextContent("backup");
    expect(web).toHaveTextContent("/etc/ssl/a.pem valid to 2027-01-05");
    expect(web).toHaveTextContent("/etc/sudoers there, but may not be read");

    fireEvent.click(within(web).getByRole("button", { name: "Read now" }));
    expect(act).toHaveBeenLastCalledWith({ action: "facts-collect-now", serverId: "web" });
    fireEvent.click(within(screen.getByTestId("facts-server-nas")).getByRole("button", { name: "Read this one too" }));
    expect(act).toHaveBeenLastCalledWith({ action: "facts-configure", exclude: [] });
    fireEvent.click(within(web).getByRole("button", { name: "Leave alone" }));
    expect(act).toHaveBeenLastCalledWith({ action: "facts-configure", exclude: ["nas", "web"] });
  });

  it("saves extra paths to watch and the interval", async () => {
    const act = vi.fn(async () => hub());
    render(<ServerFactsCard hub={hub()} act={act} />);
    fireEvent.change(screen.getByLabelText("Reading interval"), { target: { value: "24" } });
    expect(act).toHaveBeenLastCalledWith({ action: "facts-configure", intervalHours: 24 });
    const paths = screen.getByLabelText("Extra watched files");
    fireEvent.change(paths, { target: { value: "/etc/myapp/app.conf\n\n /opt/x/*.conf " } });
    fireEvent.blur(paths);
    expect(act).toHaveBeenLastCalledWith({ action: "facts-configure", watchPaths: ["/etc/myapp/app.conf", "/opt/x/*.conf"] });
    fireEvent.click(screen.getByRole("button", { name: "Read all now" }));
    expect(act).toHaveBeenLastCalledWith({ action: "facts-collect-now" });
  });
});
