import { useState } from "react";
import type { AtlassianConnectionInput, HubSnapshot } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import type { Act } from "./panelShared";

type Product = "jira" | "confluence";

const NAME: Record<Product, string> = { jira: "Jira", confluence: "Confluence" };

const ago = (at: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};

/** What the connection is doing, in the line a closed fold shows. */
export function atlassianSummary(product: Product, atlassian: HubSnapshot["atlassian"]): string {
  const c = atlassian?.[product];
  if (!c) return `${NAME[product]} · not connected`;
  if (!c.enabled) return `${NAME[product]} · connected, switched off`;
  if (c.lastError) return `${NAME[product]} · could not be read: ${c.lastError}`;
  if (product === "jira")
    return c.projects?.length
      ? `Jira · mirroring ${c.projects.join(", ")}${c.lastSyncAt ? ` · read ${ago(c.lastSyncAt)}` : ""}`
      : "Jira · connected, no project chosen";
  return `Confluence · connected${c.watched?.length ? ` · ${c.watched.length} source${c.watched.length === 1 ? "" : "s"} followed` : ""}`;
}

/**
 * The connection to Jira or to Confluence: where, as whom, and for Jira which
 * projects are mirrored on the board. The token is typed here and never shown
 * again; an empty token field keeps the stored one.
 */
export function AtlassianCard({ product, hub, act }: { product: Product; hub: HubSnapshot; act: Act }): JSX.Element {
  const saved = hub.atlassian?.[product];
  const canChange = hub.atlassian?.canChange !== false;
  const [variant, setVariant] = useState<"cloud" | "datacenter">(saved?.variant ?? "cloud");
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? "");
  const [email, setEmail] = useState(saved?.email ?? "");
  const [token, setToken] = useState("");
  const [projects, setProjects] = useState((saved?.projects ?? []).join(", "));
  const [doneTransition, setDoneTransition] = useState(saved?.doneTransition ?? "");
  const [closeOnApprove, setCloseOnApprove] = useState(saved?.closeOnApprove !== false);
  const [enabled, setEnabled] = useState(saved?.enabled !== false);
  const [busy, setBusy] = useState("");
  const [said, setSaid] = useState("");
  const [offered, setOffered] = useState<{ key: string; name: string }[]>([]);

  const chosen = projects
    .split(/[\s,]+/)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  const connection = (): AtlassianConnectionInput => ({
    product,
    variant,
    baseUrl: baseUrl.trim(),
    email: variant === "cloud" ? email.trim() : undefined,
    token: token.trim() || undefined,
    enabled,
    ...(product === "jira" ? { projects: chosen, doneTransition: doneTransition.trim() || undefined, closeOnApprove } : {}),
  });

  const save = async (): Promise<boolean> => {
    setBusy("save");
    setSaid("");
    const next = await act({ action: "atlassian-save", connection: connection() });
    setBusy("");
    if (!next) return false;
    setToken("");
    setSaid("Saved.");
    return true;
  };
  const test = async (): Promise<void> => {
    // What is tested is what is in the form: saved first, so a typed token is the one that is tried.
    if (!(await save())) return;
    setBusy("test");
    const result = (await act({ action: "atlassian-test", product }))?.reply?.atlassianTest;
    setBusy("");
    if (!result) return;
    if (!result.ok) return setSaid(`It did not work: ${result.error ?? "no answer"}`);
    const list = product === "jira" ? (result.projects ?? []) : (result.spaces ?? []);
    setOffered(list);
    setSaid(
      product === "jira"
        ? `Signed in as ${result.account}. ${list.length} project${list.length === 1 ? "" : "s"} can be seen.`
        : `It works. ${list.length} space${list.length === 1 ? "" : "s"} can be seen.`,
    );
  };
  const syncNow = async (): Promise<void> => {
    setBusy("sync");
    setSaid("");
    const result = (await act({ action: "jira-sync-now" }))?.reply?.jiraSync;
    setBusy("");
    if (result)
      setSaid(
        `Read. ${result.added} new, ${result.updated} changed, ${result.written} written to Jira.${result.more ? " There were more issues than are read at once; the rest come with the next reads." : ""}`,
      );
  };
  const toggle = (key: string): void =>
    setProjects((chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]).join(", "));

  return (
    <details className="ai-fold ai-set-fold" data-testid={`${product}-connection`}>
      <summary>{atlassianSummary(product, hub.atlassian)}</summary>
      <div className="ai-form">
        <p className="ai-hint">
          {product === "jira"
            ? "Every open issue of the projects you choose becomes a ticket on the board, and follows the issue. An issue's text comes from outside the team, so its ticket waits in Backlog until a person moves it. sshS3 writes only this to Jira: an agent's result as a comment, your decision as a comment, and the issue closed when its ticket is done here."
            : "Pages of a Confluence space can be added as sources of the knowledge base and are read again when they change. A knowledge base page can be published to Confluence, by a person, never by an agent."}
        </p>
        {!canChange && <p className="ai-hint">Only an administrator of this server connects {NAME[product]}.</p>}
        <fieldset disabled={!canChange} style={{ border: 0, padding: 0, margin: 0, display: "contents" }}>
          <label>
            Kind
            <select value={variant} onChange={(e) => setVariant(e.target.value === "datacenter" ? "datacenter" : "cloud")}>
              <option value="cloud">Atlassian Cloud (e-mail and API token)</option>
              <option value="datacenter">Data Center or Server (personal access token)</option>
            </select>
          </label>
          <label>
            Address
            <input
              type="url"
              value={baseUrl}
              placeholder={variant === "cloud" ? "https://your-team.atlassian.net" : `https://${product}.example.com`}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          {variant === "cloud" && (
            <label>
              E-mail of the account
              <input type="email" value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
            </label>
          )}
          <label>
            {variant === "cloud" ? "API token" : "Personal access token"}
            <input
              type="password"
              value={token}
              autoComplete="new-password"
              placeholder={saved?.hasToken ? "Set. Leave empty to keep it." : ""}
              onChange={(e) => setToken(e.target.value)}
            />
            <small>
              It acts as that account: use one that may only do what sshS3 should. Kept encrypted on this
              {hub.atlassian?.canChange === false ? " server" : " installation"}, never shared with the team bucket.
            </small>
          </label>
          {product === "jira" && (
            <>
              <label>
                Projects to mirror (keys, separated by commas)
                <input value={projects} placeholder="OPS, NET" onChange={(e) => setProjects(e.target.value)} />
              </label>
              {offered.length > 0 && (
                <div className="ai-tags" data-testid="jira-projects-offered">
                  {offered.slice(0, 60).map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={`ai-chip ${chosen.includes(p.key) ? "ai-chip-on" : ""}`}
                      aria-pressed={chosen.includes(p.key)}
                      title={p.name}
                      onClick={() => toggle(p.key)}
                    >
                      {p.key}
                    </button>
                  ))}
                </div>
              )}
              <label className="ai-check">
                <input type="checkbox" checked={closeOnApprove} onChange={(e) => setCloseOnApprove(e.target.checked)} />
                Close the issue in Jira when its ticket is done here
              </label>
              {closeOnApprove && (
                <label>
                  Transition to use (optional)
                  <input value={doneTransition} placeholder="Done" onChange={(e) => setDoneTransition(e.target.value)} />
                  <small>
                    Empty: the one called Done, Resolved or Closed. When a workflow has several ways to close and none is
                    named here, the issue is left open and the ticket says so.
                  </small>
                </label>
              )}
            </>
          )}
          <label className="ai-check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {product === "jira" ? "Mirror Jira on the board" : "Use this connection"}
          </label>
          <div className="ai-card-actions">
            <button type="button" className="ai-btn-accent" disabled={Boolean(busy) || !baseUrl.trim()} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={Boolean(busy) || !baseUrl.trim()} onClick={() => void test()}>
              {busy === "test" ? "Testing…" : "Save and test"}
            </button>
            {product === "jira" && saved && (
              <button type="button" disabled={Boolean(busy)} onClick={() => void syncNow()}>
                {busy === "sync" ? "Reading…" : "Sync now"}
              </button>
            )}
            {saved && (
              <ConfirmButton
                label="Disconnect"
                confirmLabel={`Disconnect ${NAME[product]}?`}
                onConfirm={() => void act({ action: "atlassian-disconnect", product }).then(() => setSaid("Disconnected. What was mirrored stays."))}
              />
            )}
          </div>
        </fieldset>
        {said && (
          <p role="status" className="ai-hint" data-testid={`${product}-said`}>
            {said}
          </p>
        )}
      </div>
    </details>
  );
}
