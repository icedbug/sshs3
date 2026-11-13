import { describe, expect, it } from "vitest";
import { addressClass, guardUrl } from "../../src/main/ai/hub/Notifier";
import { parseAlerts } from "../../src/main/ai/hub/AlertIntake";
import { inboxItems } from "../../src/shared/aiHubInbox";

/** From the review of feature 6. */

describe("where a shared server may send or fetch", () => {
  it("knows an IPv4 address written inside IPv6, in every form a URL parser or DNS gives", () => {
    expect(addressClass("::ffff:7f00:1")).toBe("loopback");
    expect(addressClass("::ffff:a9fe:a9fe")).toBe("link-local");
    expect(addressClass("[::ffff:a9fe:a9fe]")).toBe("link-local");
    expect(addressClass("::ffff:127.0.0.1")).toBe("loopback");
    expect(addressClass("64:ff9b::a00:1")).toBe("private");
    expect(addressClass("::ffff:808:808")).toBe("public");
  });

  it("refuses cloud metadata and its own loopback written that way", async () => {
    for (const url of ["http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[::ffff:127.0.0.1]:8080/"])
      await expect(guardUrl(url, { server: true, allowPrivate: false, allowPlainHttp: true })).rejects.toThrow();
  });
});

describe("what an alert's status means", () => {
  it("takes only known words for 'over', and 'unresolved' or 'not_ok' as still firing", () => {
    const status = (s: string) => parseAlerts({ title: "Disk full on db01", status: s })[0].status;
    expect(["unresolved", "not_ok", "firing", "alerting", "critical"].map(status)).toEqual(["firing", "firing", "firing", "firing", "firing"]);
    expect(["resolved", "OK", "recovered", "closed"].map(status)).toEqual(["resolved", "resolved", "resolved", "resolved"]);
  });

  it("does not take a PagerDuty acknowledgement for the incident firing again", () => {
    const pd = (event_type: string) =>
      parseAlerts({ event: { event_type, data: { id: "P1", title: "API down", urgency: "high" } } })[0];
    expect(pd("incident.triggered").update).toBeUndefined();
    expect(pd("incident.acknowledged").update).toBe(true);
    expect(pd("incident.annotated").update).toBe(true);
  });
});

describe("an alert in the inbox", () => {
  it("stays there while it is assigned to an agent that has not started it", () => {
    const ticket = {
      id: "t1",
      title: "Alert (critical): Disk almost full",
      description: "",
      status: "todo",
      assigneeAgentId: "dba",
      assigneeName: "DBA",
      createdAt: 1,
      updatedAt: 1,
      alert: { fingerprint: "f", source: "Alertmanager", severity: "critical", firstAt: 1, lastAt: 1, count: 1 },
    };
    const items = inboxItems({ tasks: [], workTickets: [ticket] } as never);
    expect(items.find((i) => i.id === "alert:t1")).toMatchObject({ detail: "With DBA, not started yet" });
    expect(inboxItems({ tasks: [], workTickets: [{ ...ticket, status: "in_progress" }] } as never).find((i) => i.id === "alert:t1")).toBeUndefined();
  });
});
