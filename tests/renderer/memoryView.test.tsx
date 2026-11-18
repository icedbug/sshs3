// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { Memory } from "../../src/renderer/src/components/AiHub/MemoryView";

function makeHub(memories: HubSnapshot["memories"]): HubSnapshot {
  return {
    config: {
      enabled: true,
      provider: "openai-compatible",
      model: "local",
      useHermes: true,
      hasApiKey: false,
    },
    preferences: {
      background: false,
      autoStart: false,
      inventory: false,
      retentionDays: 30,
    },
    runtime: { bundled: true },
    sessions: [],
    tasks: [],
    memories,
    schedules: [],
    inventory: [],
  };
}

const entry = {
  id: "mem-1",
  kind: "memory" as const,
  tier: "archival" as const,
  scope: "workspace",
  title: "Backup schedule",
  text: "Nightly backups run at 02:00 UTC.",
  author: "Maria Ek",
  createdAt: 1,
  updatedAt: 1,
};

describe("MemoryView inline save error on stale edit", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows inline error inside the Edit entry form and preserves text when stale save is rejected", async () => {
    const hub = makeHub([entry]);
    const act = vi.fn();
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "This memory was deleted by Maria Ek just now, so the change was not saved. Save it as a new memory to keep the text.",
        ),
      )
      .mockResolvedValueOnce(hub);

    const { rerender } = render(<Memory hub={hub} act={act} request={request} suggestion="" />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const form = screen.getByTestId("memory-add-form");
    const textarea = within(form).getByRole("textbox", { name: /what should be remembered/i });
    fireEvent.change(textarea, { target: { value: "Nightly backups run at 03:00 UTC." } });

    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(within(form).getByTestId("memory-form-error")).toHaveTextContent(
        "This memory was deleted by Maria Ek just now, so the change was not saved. Save it as a new memory to keep the text.",
      ),
    );
    expect(textarea).toHaveValue("Nightly backups run at 03:00 UTC.");

    // Simulate snapshot update removing the deleted memory from the list.
    rerender(<Memory hub={makeHub([])} act={act} request={request} suggestion="" />);
    expect(within(form).getByTestId("memory-form-error")).toHaveTextContent(
      "This memory was deleted by Maria Ek just now",
    );

    const saveAsNewBtn = within(form).getByRole("button", { name: "Save as new" });
    fireEvent.click(saveAsNewBtn);

    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith({
        action: "memory-save",
        entry: expect.objectContaining({
          id: undefined,
          title: "Backup schedule",
          text: "Nightly backups run at 03:00 UTC.",
        }),
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("memory-add-form")).not.toBeInTheDocument());
  });
});

describe("MemoryView says what its marks mean and when it hid a secret", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("explains pinned, global, the votes and Tidy up in words on the page", () => {
    render(<Memory hub={makeHub([entry])} act={vi.fn()} suggestion="" />);
    const legend = screen.getByTestId("memory-legend");
    expect(legend).toHaveTextContent("pinned: always read first.");
    expect(legend).toHaveTextContent("global: for the team, on every server.");
    expect(legend).toHaveTextContent("Useful and Not useful rank an entry higher or lower");
    expect(legend).toHaveTextContent("Tidy up looks for entries that say the same thing");
    // It does not claim that everything is asked about first: some of it is written straight away.
    expect(legend).toHaveTextContent("Some of what it finds it writes straight away");
    expect(legend).toHaveTextContent("the rest it lists above the entries for you to accept or reject");
    expect(legend).toHaveTextContent("It says which when it is done.");
  });

  it("shows what Tidy up did, in the hub's own words", async () => {
    const notes = ["Tidy up did this without asking:", 'Changed 1 entry: "Backup schedule".', "2 suggestions wait above for you to accept or reject."];
    const act = vi.fn().mockResolvedValue({ ...makeHub([entry]), reply: { notes } });
    render(<Memory hub={makeHub([entry])} act={act} suggestion="" />);
    expect(screen.queryByTestId("tidy-result")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("run-self-reflection-btn"));
    const result = await screen.findByTestId("tidy-result");
    expect(act).toHaveBeenCalledWith({ action: "self-learn-reflect" });
    for (const line of notes) expect(result).toHaveTextContent(line);
  });

  it("says so when a password in a new entry was hidden before it was saved", async () => {
    const saved = { ...entry, id: "mem-2", title: "Database login", text: "db password=[redacted]" };
    const request = vi.fn().mockResolvedValue(makeHub([entry, saved]));
    render(<Memory hub={makeHub([entry])} act={vi.fn()} request={request} suggestion="" />);
    fireEvent.click(screen.getByRole("button", { name: /Add|New|Write/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Database login" } });
    fireEvent.change(screen.getByLabelText("What should be remembered"), { target: { value: "db password=Hunter2Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("memory-hidden-note")).toHaveTextContent('A password, key or token in "Database login" was hidden before it was saved. Only "[redacted]" is kept.');
  });

  it("says nothing of the kind when nothing was hidden", async () => {
    const saved = { ...entry, id: "mem-3", title: "Reload nginx", text: "nginx -t first." };
    const request = vi.fn().mockResolvedValue(makeHub([entry, saved]));
    render(<Memory hub={makeHub([entry])} act={vi.fn()} request={request} suggestion="" />);
    fireEvent.click(screen.getByRole("button", { name: /Add|New|Write/ }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Reload nginx" } });
    fireEvent.change(screen.getByLabelText("What should be remembered"), { target: { value: "nginx -t first." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(screen.queryByTestId("memory-hidden-note")).not.toBeInTheDocument();
  });
});
