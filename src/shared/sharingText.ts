/**
 * What is shared and what is each person's own, said in one place so every screen says the same.
 *
 * Where the team's things are kept decides it. On a web server everybody with an account has
 * them. A team bucket carries them to other installations. With neither, they stay on one computer.
 */
export interface SharingPlace {
  /** A web server that people sign in to. */
  server: boolean;
  /** A team bucket is connected. */
  bucket: boolean;
  /** The demo lab: made-up servers and tickets, a copy for each person. */
  demo?: boolean;
}

export interface SharingText {
  /** What others have too, and who they are. */
  shared: string;
  /** What stays this person's own. Empty where nothing is shared at all. */
  personal: string;
  /** What to do to share more, or where a bucket comes in. */
  more?: string;
}

const TEAM_THINGS = "the team's servers and clusters (without anybody's keys), the Workforce board (goals, tickets, agents), the Knowledge Base, team memory and runbooks, and the activity log";
const personalThings = (whose: "your" | "their"): string =>
  `${whose} model and its key, ${whose} Jira and Confluence sign-in, ${whose} safety rules, ${whose} own memories and conversations, ${whose} inbox and notification channels, and ${whose} own servers, keys and passwords`;

/**
 * `reader`: who the words are for. "you" is the person looking at their own workspace. "each" is
 * somebody reading about the people who will have an account (the administrator who invites them).
 */
export function sharingText(place: SharingPlace, reader: "you" | "each" = "you"): SharingText {
  const mine = reader === "you" ? `Yours alone: ${personalThings("your")}.` : `Each person's own: ${personalThings("their")}.`;
  if (place.demo)
    return {
      shared: "This is the demo lab. Its servers, board and knowledge base are made up, and each person has a copy of their own: nothing here is shared.",
      personal: "",
    };
  if (place.server)
    return {
      shared: `Everyone with an account on this server shares ${TEAM_THINGS}. They share the team's chat bot too, and see who is signed in and which servers each person is connected to.`,
      personal: mine,
      more: place.bucket
        ? "The team bucket carries the same board, agents, Knowledge Base, team memory and activity to desktop apps and other servers that use it."
        : "A team bucket is needed only to share with desktop apps or with another server.",
    };
  if (place.bucket)
    return {
      shared: `Everyone who uses the team bucket shares ${TEAM_THINGS}. They also see who is online.`,
      personal: reader === "you" ? `Yours alone, on this computer: ${personalThings("your")}.` : mine,
    };
  return {
    shared: "Nothing is shared. Memory, runbooks, the board and activity stay on this computer.",
    personal: "",
    more: "Connect a team bucket from the start page (Connect S3 team bucket) to share them with a team.",
  };
}

/** The one line for the start page, where no team bucket is connected: what is shared all the same, or what a bucket would share. */
export function sharingWithoutBucket(server: boolean): string {
  return server
    ? "Shared on this web server: everyone with an account has the team's servers and clusters, the Workforce board, agents, the Knowledge Base, team memory and activity. A team bucket is needed only to share with desktop apps or another server."
    : "Not connected. A team bucket shares servers, clusters, team memory, the Workforce board, agents and the Knowledge Base (only S3 keys are needed).";
}

/** The one line for the board: who has it. */
export function boardSharedWith(place: SharingPlace): string {
  if (place.demo) return "The demo lab's board is yours alone";
  if (place.server) return "Shared with everyone who has an account on this server";
  if (place.bucket) return "Shared with everyone who uses the team bucket";
  return "Board stays on this computer. Connect a team bucket from the start page to share tickets and goals";
}
