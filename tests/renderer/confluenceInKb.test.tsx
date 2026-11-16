// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { ConfluenceSources, PublishToConfluence } from "../../src/renderer/src/components/AiHub/ConfluenceSources";

afterEach(cleanup);

const connection = { product: "confluence" as const, variant: "cloud" as const, baseUrl: "https://acme.atlassian.net", email: "ops@acme.se", hasToken: true, enabled: true };
const hub = (confluence?: HubSnapshot["atlassian"]): HubSnapshot => ({ atlassian: confluence }) as unknown as HubSnapshot;

describe("Confluence under Sources", () => {
  it("offers only the connection until Confluence is connected", () => {
    render(<ConfluenceSources hub={hub({})} act={vi.fn(async () => undefined)} />);
    expect(screen.getByTestId("confluence-connection")).toHaveTextContent("Confluence · not connected");
    expect(screen.queryByTestId("kb-confluence")).toBeNull();
  });

  it("adds a space by its key and a page tree by its id, and says what came of it", async () => {
    const sent: HubRequest[] = [];
    const act = vi.fn(async (request: HubRequest) => {
      sent.push(request);
      return { reply: { ingest: { added: ["A", "B"], duplicates: ["C"], failed: [], updated: [], notes: ["There were more pages than are read at once (500); the rest were left out. Add a smaller tree to get them."] } } } as unknown as HubSnapshot;
    });
    render(
      <ConfluenceSources
        hub={hub({ confluence: { ...connection, watched: [{ kind: "space", ref: "OPS", addedAt: 1, by: "Jacob", pages: 12 }] } })}
        act={act}
      />,
    );
    const fold = screen.getByTestId("kb-confluence");
    expect(fold).toHaveTextContent("Add from Confluence · following 1");
    expect(within(fold).getByTestId("kb-confluence-followed")).toHaveTextContent("Space OPS · 12 pages · added by Jacob");

    const input = within(fold).getByLabelText("Space key or page id");
    fireEvent.change(input, { target: { value: "NET" } });
    fireEvent.click(within(fold).getByRole("button", { name: "Add this space", hidden: true }));
    await waitFor(() => expect(within(fold).getByTestId("kb-confluence-said")).toHaveTextContent("2 pages added, 1 already here. There were more pages than are read at once"));
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(within(fold).getByRole("button", { name: "Add this page tree", hidden: true }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { action: "kb-ingest-confluence", spaceKey: "NET" },
      { action: "kb-ingest-confluence", pageId: "123456" },
    ]);
    fireEvent.click(within(fold).getByRole("button", { name: "Stop following", hidden: true }));
    await waitFor(() => expect(sent[2]).toEqual({ action: "kb-confluence-unfollow", ref: "OPS" }));
  });
});

describe("publishing a page to Confluence", () => {
  it("is not offered without a connection", () => {
    const { container } = render(<PublishToConfluence page={{ id: "p1", revision: 1 }} hub={hub({})} act={vi.fn(async () => undefined)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("asks where the first time, and needs a second click to replace a page that is already there", async () => {
    const sent: HubRequest[] = [];
    const act = vi.fn(async (request: HubRequest) => (sent.push(request), {} as HubSnapshot));
    const connected = hub({ confluence: connection });
    const first = render(<PublishToConfluence page={{ id: "p1", revision: 3 }} hub={connected} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish to Confluence" }));
    const form = screen.getByTestId("kb-publish-form-p1");
    expect(within(form).getByRole("button", { name: "Create the page in Confluence" })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Space key"), { target: { value: "OPS" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create the page in Confluence" }));
    await waitFor(() => expect(sent).toEqual([{ action: "kb-page-publish", id: "p1", spaceKey: "OPS", parentId: undefined }]));
    first.unmount();

    const published = { system: "confluence" as const, pageId: "900", url: "https://acme.atlassian.net/wiki/x", version: 1, revision: 3, at: 1, by: "Anna" };
    render(<PublishToConfluence page={{ id: "p1", revision: 4, published }} hub={connected} act={act} />);
    expect(screen.getByTestId("kb-published-p1")).toHaveTextContent("In Confluence, at revision 3 of 4 · by Anna");
    fireEvent.click(screen.getByRole("button", { name: "Publish the changes" }));
    expect(sent).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Replace the page in Confluence?" }));
    await waitFor(() => expect(sent[1]).toEqual({ action: "kb-page-publish", id: "p1" }));
  });
});
