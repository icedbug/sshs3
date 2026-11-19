import { describe, expect, it } from "vitest";
import { boardSharedWith, sharingText, sharingWithoutBucket } from "../../src/shared/sharingText";

/**
 * What is shared and what is each person's own is said in one place, so the start page, the invite
 * panel, the settings and the board cannot say different things.
 */
describe("what is shared, in one place", () => {
  it("says that everyone on a server has the board, the agents and the knowledge base without a bucket", () => {
    const text = sharingText({ server: true, bucket: false });
    expect(text.shared).toBe(
      "Everyone with an account on this server shares the team's servers and clusters (without anybody's keys), the Workforce board (goals, tickets, agents), the Knowledge Base, team memory and runbooks, and the activity log. They share the team's chat bot too, and see who is signed in and which servers each person is connected to.",
    );
    expect(text.personal).toBe(
      "Yours alone: your model and its key, your Jira and Confluence sign-in, your safety rules, your own memories and conversations, your inbox and notification channels, and your own servers, keys and passwords.",
    );
    expect(text.more).toBe("A team bucket (S3 storage the whole team uses) is needed only to share with desktop apps or with another server.");
    // Nothing sends a team that works in the browser to a bucket for its board.
    expect(`${text.shared} ${text.more}`).not.toMatch(/connect an? (S3 )?(team )?bucket/i);
  });

  it("says what a bucket adds on a server, and who shares through a bucket from a computer", () => {
    expect(sharingText({ server: true, bucket: true }).more).toBe(
      "The team bucket carries the same board, agents, Knowledge Base, team memory and activity to desktop apps and other servers that use it.",
    );
    const desktop = sharingText({ server: false, bucket: true });
    expect(desktop.shared).toMatch(/^Everyone who uses the team bucket shares the team's servers and clusters/);
    expect(desktop.shared).toContain("They also see who is online.");
    // The chat bot is never in the bucket.
    expect(desktop.shared).not.toContain("chat bot");
    expect(desktop.personal).toMatch(/^Yours alone, on this computer: your model and its key/);
  });

  it("says that nothing is shared from one computer without a bucket, and in the demo lab", () => {
    expect(sharingText({ server: false, bucket: false })).toEqual({
      shared: "Nothing is shared. Memory, runbooks, the board and activity stay on this computer.",
      personal: "",
      more: "Connect a team bucket (S3 storage the whole team uses) from the start page to share them with a team.",
    });
    expect(sharingText({ server: true, bucket: false, demo: true })).toEqual({
      shared: "This is the demo lab. Its servers, board and knowledge base are made up, and each person has a copy of their own: nothing here is shared.",
      personal: "",
    });
  });

  it("speaks of the people being invited when it is read by the one who invites them", () => {
    const text = sharingText({ server: true, bucket: false }, "each");
    expect(text.personal).toBe(
      "Each person's own: their model and its key, their Jira and Confluence sign-in, their safety rules, their own memories and conversations, their inbox and notification channels, and their own servers, keys and passwords.",
    );
    expect(text.shared).toBe(sharingText({ server: true, bucket: false }).shared);
  });

  it("has the short lines for the board and the start page", () => {
    expect(boardSharedWith({ server: true, bucket: false })).toBe("Shared with everyone who has an account on this server");
    expect(boardSharedWith({ server: false, bucket: true })).toBe("Shared with everyone who uses the team bucket");
    expect(boardSharedWith({ server: false, bucket: false, demo: true })).toBe("The demo lab's board is yours alone");
    expect(boardSharedWith({ server: false, bucket: false })).toBe("Board stays on this computer. Connect a team bucket from the start page to share tickets and goals");
    expect(sharingWithoutBucket(true)).toMatch(/^Shared on this web server: everyone with an account has .* the Workforce board, agents, the Knowledge Base/);
    expect(sharingWithoutBucket(true)).toContain("A team bucket is needed only to share with desktop apps or another server.");
    expect(sharingWithoutBucket(false)).toMatch(/^Not connected\. A team bucket shares/);
  });
});
