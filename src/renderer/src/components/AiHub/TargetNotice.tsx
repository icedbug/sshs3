import { namesWhole } from "@shared/namesWhole";

/** A saved server as the notice needs it: its name, and its tags, which say whether it is production. */
export interface NoticeServer {
  name: string;
  tags?: string[];
}

/** The tags that mark a server as production, as the safety rules read them. */
const PRODUCTION = new Set(["prod", "production", "critical"]);
const isProduction = (server: NoticeServer | undefined): boolean => Boolean(server?.tags?.some((t) => PRODUCTION.has(t.toLowerCase())));

/**
 * The servers a message names that are not the one its conversation runs on, when it does not name
 * that one too. A conversation runs on the terminal it was started in, whatever its first message
 * says: "on web-02 please" typed while app-01's tab is open still runs on app-01.
 */
export function targetMismatch(
  text: string,
  target: string | undefined,
  servers: readonly NoticeServer[],
): { named: string[]; target: string; production: boolean } | undefined {
  if (!target || !text.trim()) return undefined;
  const named = servers.filter((s) => namesWhole(text, s.name));
  if (named.length === 0 || named.some((s) => s.name.toLowerCase() === target.toLowerCase())) return undefined;
  return { named: named.map((s) => s.name), target, production: isProduction(servers.find((s) => s.name.toLowerCase() === target.toLowerCase())) };
}

/**
 * Above the composer: that the message names another server than the one this conversation runs on,
 * and that the terminal it runs on is a production server. Found by a tester in a hurry, whose request
 * for web-02 started on production app-01 because that tab was open.
 */
export function TargetNotice({ text, target, servers }: { text: string; target?: string; servers: readonly NoticeServer[] }): JSX.Element | null {
  const mismatch = targetMismatch(text, target, servers);
  if (mismatch) {
    const names = mismatch.named.length === 1 ? mismatch.named[0] : `${mismatch.named.slice(0, -1).join(", ")} and ${mismatch.named.at(-1)}`;
    return (
      <p className="ai-target-notice ai-target-notice-warn" role="status" data-testid="ai-target-mismatch">
        Your message names {names}, but this conversation runs on {mismatch.target}
        {mismatch.production ? ", a production server" : ""}. Open a terminal on {mismatch.named[0]} and start the conversation there
        to run it on {mismatch.named[0]}.
      </p>
    );
  }
  const own = servers.find((s) => target && s.name.toLowerCase() === target.toLowerCase());
  if (own && isProduction(own))
    return (
      <p className="ai-target-notice" data-testid="ai-target-production">
        {own.name} is a production server.
      </p>
    );
  return null;
}
