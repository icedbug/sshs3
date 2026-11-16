import { useState } from "react";
import type { HubSnapshot, KbPage } from "@shared/types/aiHub";
import { AtlassianCard } from "./AtlassianCard";
import { ConfirmButton } from "./ConfirmButton";
import type { Act } from "./panelShared";

/**
 * Confluence as a source of the knowledge base: the connection, and the
 * spaces and page trees that are followed. What is added is read again when
 * it changes in Confluence.
 */
export function ConfluenceSources({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const connection = hub.atlassian?.confluence;
  const [what, setWhat] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const ref = what.trim();
  // Digits only: a page's id (its tree is added). Anything else: a space key.
  const asPage = /^\d+$/.test(ref);

  const add = async (): Promise<void> => {
    setBusy(true);
    setSaid("");
    const result = (await act({ action: "kb-ingest-confluence", ...(asPage ? { pageId: ref } : { spaceKey: ref }) }))?.reply?.ingest;
    setBusy(false);
    if (!result) return;
    setWhat("");
    const parts = [
      result.added.length ? `${result.added.length} page${result.added.length === 1 ? "" : "s"} added` : "",
      result.updated?.length ? `${result.updated.length} revised` : "",
      result.duplicates.length ? `${result.duplicates.length} already here` : "",
      result.failed.length ? `${result.failed.length} could not be read` : "",
    ].filter(Boolean);
    setSaid(`${parts.length ? parts.join(", ") : "Nothing new: the pages are here already, or have no text"}.${result.notes?.length ? ` ${result.notes.join(" ")}` : ""}`);
  };

  return (
    <>
      <AtlassianCard product="confluence" hub={hub} act={act} />
      {connection?.enabled && connection.hasToken && (
        <details className="ai-fold" data-testid="kb-confluence">
          <summary>
            Add from Confluence{connection.watched?.length ? ` · following ${connection.watched.length}` : ""}
          </summary>
          <form
            className="ai-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (ref && !busy) void add();
            }}
          >
            <p className="ai-hint">
              A space key (like OPS) adds the pages of that space; a page id (the number in a page&apos;s address) adds that
              page and everything under it. Up to 500 pages at a time. They are read again once a day; a page that
              changed there revises what was written from it here. What looks like a password or a key is masked.
            </p>
            <div className="ai-inline-form">
              <input
                aria-label="Space key or page id"
                className="ai-mono"
                placeholder="OPS or 123456"
                value={what}
                onChange={(e) => setWhat(e.target.value)}
              />
              <button type="submit" disabled={busy || !ref}>
                {busy ? "Reading…" : asPage ? "Add this page tree" : "Add this space"}
              </button>
            </div>
            {said && (
              <p role="status" className="ai-hint" data-testid="kb-confluence-said">
                {said}
              </p>
            )}
            {(connection.watched ?? []).length > 0 && (
              <ul className="ai-link-list" data-testid="kb-confluence-followed">
                {connection.watched!.map((w) => (
                  <li key={`${w.kind}:${w.ref}`} className="ai-link">
                    <span>
                      {w.kind === "space" ? "Space" : "Page tree"} <strong>{w.ref}</strong>
                      {w.pages !== undefined ? ` · ${w.pages} page${w.pages === 1 ? "" : "s"}` : ""} · added by {w.by}
                    </span>
                    {hub.atlassian?.canChange !== false && (
                      <button type="button" onClick={() => void act({ action: "kb-confluence-unfollow", ref: w.ref })}>
                        Stop following
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </form>
        </details>
      )}
    </>
  );
}

/**
 * Publishes one knowledge base page to Confluence. Only shown when Confluence
 * is connected. The first time it asks where; after that it updates the same
 * page, and a person confirms each time: it writes outside sshS3.
 */
export function PublishToConfluence({
  page,
  hub,
  act,
}: {
  page: Pick<KbPage, "id" | "revision" | "published">;
  hub: HubSnapshot;
  act: Act;
}): JSX.Element | null {
  const connection = hub.atlassian?.confluence;
  const [asking, setAsking] = useState(false);
  const [spaceKey, setSpaceKey] = useState("");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  if (!connection?.enabled || !connection.hasToken) return null;
  const published = page.published;
  const publish = async (where: { spaceKey?: string; parentId?: string }): Promise<void> => {
    setBusy(true);
    const next = await act({ action: "kb-page-publish", id: page.id, ...where });
    setBusy(false);
    if (next) setAsking(false);
  };
  return (
    <>
      {published ? (
        <>
          <ConfirmButton
            label={busy ? "Publishing…" : published.revision === page.revision ? "Publish again" : "Publish the changes"}
            confirmLabel="Replace the page in Confluence?"
            className=""
            disabled={busy}
            onConfirm={() => void publish({})}
          />
          <small className="ai-muted" data-testid={`kb-published-${page.id}`}>
            <a href={published.url} target="_blank" rel="noreferrer noopener">
              In Confluence
            </a>
            {published.revision === page.revision ? ", up to date" : `, at revision ${published.revision} of ${page.revision}`} · by {published.by}
          </small>
        </>
      ) : asking ? (
        <form
          className="ai-inline-form"
          data-testid={`kb-publish-form-${page.id}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (spaceKey.trim() && !busy) void publish({ spaceKey: spaceKey.trim(), parentId: parentId.trim() || undefined });
          }}
        >
          <input aria-label="Space key" className="ai-mono" placeholder="Space key, like OPS" value={spaceKey} onChange={(e) => setSpaceKey(e.target.value)} />
          <input aria-label="Parent page id (optional)" className="ai-mono" placeholder="Parent page id (optional)" value={parentId} onChange={(e) => setParentId(e.target.value)} />
          <button type="submit" disabled={busy || !spaceKey.trim()}>
            {busy ? "Publishing…" : "Create the page in Confluence"}
          </button>
          <button type="button" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setAsking(true)}>
          Publish to Confluence
        </button>
      )}
    </>
  );
}
