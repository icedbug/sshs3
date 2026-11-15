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
