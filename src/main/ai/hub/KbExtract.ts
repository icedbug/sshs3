import crypto from "node:crypto";
import path from "node:path";
import { get, guardUrl, type GuardOptions } from "./Notifier";

/**
 * Turns what people drop into the knowledge base into text: PDF, Word, web
 * pages and plain text of any kind. Nothing here calls a model; reading for
 * title, summary and tags comes afterwards (KbEnrich).
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DOC_CHARS = 800_000;

export type ExtractedFormat = "pdf" | "docx" | "html" | "text";

export interface Extracted {
  text: string;
  format: ExtractedFormat;
  /** A title found in the material itself (a page's <title>, a document's first heading). */
  title?: string;
  pages?: number;
}

/** A readable title from a file name: `ceph_runbook-v2.pdf` → `ceph runbook v2`. */
export function titleFromName(name: string): string {
  const base = path.basename(name).replace(/\.[A-Za-z0-9]{1,8}$/, "");
  return base.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled";
}

/** The same text, however it was wrapped or spaced, gives the same hash: used to refuse a second copy. */
export function contentHash(text: string): string {
  return crypto.createHash("sha256").update(text.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex");
}

/** The document's own title: its first top-level heading, when it has one near the start. */
export function firstHeading(text: string): string | undefined {
  const m = /^#{1,2}\s+(.{3,160})$/m.exec(text.slice(0, 4000));
  return m ? m[1].replace(/[#*`]/g, "").trim() : undefined;
}

function looksBinary(data: Buffer): boolean {
  const sample = data.subarray(0, 4000);
  let odd = 0;
  for (const byte of sample) if (byte === 0 || (byte < 9 && byte !== 0)) odd++;
  return odd > 2;
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** `article`: look for the page's main text and drop what surrounds it. Off for a document that is all main text. */
async function htmlToMarkdown(
  html: string,
  url?: string,
  article_ = true,
): Promise<{ text: string; title?: string }> {
  const [{ parseHTML }, { Readability }, turndownModule] = await Promise.all([
    import("linkedom"),
    import("@mozilla/readability"),
    import("turndown"),
  ]);
  const TurndownService = turndownModule.default;
  const { document } = parseHTML(html);
  const pageTitle = document.querySelector("title")?.textContent?.trim() || undefined;
  if (url) {
    // Relative links are useless once the page is text: make them absolute.
    for (const a of document.querySelectorAll("a[href]")) {
      try {
        a.setAttribute("href", new URL(a.getAttribute("href") ?? "", url).toString());
      } catch {
        // An odd href stays as it is.
      }
    }
  }
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  // The text is read by people and searched, not rendered back to the same page:
  // escaping would turn pg_ctl into pg\_ctl and break every command in prose.
  turndown.escape = (text: string): string => text;
  turndown.remove(["script", "style", "noscript", "iframe", "nav", "footer"]);
  turndown.remove((node) => node.nodeName.toLowerCase() === "svg");
  let article: { title?: string | null; content?: string | null } | null = null;
  if (article_)
    try {
      // Readability changes the document it is given: work on a copy (with the links already absolute).
      article = new Readability(parseHTML(document.toString()).document as unknown as Document).parse();
    } catch {
      article = null;
    }
  const body = article?.content?.trim() ? article.content : (document.body?.innerHTML ?? html);
  const text = tidy(turndown.turndown(body));
  return { text, title: article?.title?.trim() || pageTitle };
}

/**
 * The text of an uploaded file. Throws with a reason a person can act on when
 * the file is not something text can be taken from.
 */
export async function extractText(input: { name: string; mime?: string; data: Buffer }): Promise<Extracted> {
  const { data } = input;
  if (data.length === 0) throw new Error("The file is empty.");
  if (data.length > MAX_UPLOAD_BYTES)
    throw new Error(`The file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
  const ext = path.extname(input.name).toLowerCase();
  const mime = (input.mime ?? "").toLowerCase();
  const head = data.subarray(0, 8).toString("latin1");

  if (head.startsWith("%PDF") || ext === ".pdf" || mime === "application/pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    let pages: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const out = await pdfText(pdf, { mergePages: false });
      pages = Array.isArray(out.text) ? out.text : [String(out.text)];
    } catch (error) {
      throw new Error(`The PDF could not be read (${error instanceof Error ? error.message : "unknown error"}).`, {
        cause: error,
      });
    }
    const text = tidy(pages.map((p) => p.trim()).filter(Boolean).join("\n\n"));
    if (text.length < 20)
      throw new Error("The PDF has no text in it. It is probably scanned pages; those cannot be read yet.");
    return { text, format: "pdf", pages: pages.length };
  }

  if (ext === ".docx" || mime.includes("wordprocessingml")) {
    const mammoth = await import("mammoth");
    let html: string;
    try {
      html = (await mammoth.convertToHtml({ buffer: data })).value;
    } catch (error) {
      throw new Error("The Word document could not be read.", { cause: error });
    }
    const { text } = await htmlToMarkdown(`<html><body>${html}</body></html>`, undefined, false);
    if (!text) throw new Error("The Word document has no text in it.");
    return { text, format: "docx", title: firstHeading(text) };
  }
  if (ext === ".doc") throw new Error("Old Word files (.doc) cannot be read. Save it as .docx or PDF.");

  if (ext === ".html" || ext === ".htm" || mime.includes("html") || /^\s*<(!doctype html|html)/i.test(head)) {
    const { text, title } = await htmlToMarkdown(data.toString("utf8"));
    if (!text) throw new Error("The page has no text in it.");
    return { text, format: "html", title };
  }

  if (/^image\//.test(mime) || [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext))
    throw new Error("Pictures cannot be read into the knowledge base yet. Attach it in the chat instead.");

  // An unknown extension is fine as long as the content is text (a config file without one, a log).
  if (looksBinary(data))
    throw new Error(`${ext ? `A ${ext} file` : "This file"} is not text and cannot be read.`);
  const text = tidy(data.toString("utf8"));
  if (!text) throw new Error("The file has no text in it.");
  return { text, format: "text", title: firstHeading(text) };
}

/** Fetches a page or a file from a link and takes its text. Only http and https. */
/**
 * Fetches a page for the knowledge base. Where the link leads is checked
 * before it is called, and again at every redirect: a link must not be a way
 * to make sshs3 (on a shared server, the server) read from its own loopback
 * or the cloud metadata address. `fetchImpl` replaces the network in tests.
 */
export async function fetchUrl(
  url: string,
  fetchImpl?: typeof fetch,
  guardOptions?: GuardOptions,
): Promise<Extracted & { url: string }> {
  // With the real network the check always runs; a stand-in network (tests) is checked only when a guard is given.
  const guard = guardOptions ?? (fetchImpl ? undefined : { server: false, allowPrivate: true, allowPlainHttp: true });
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch (error) {
    throw new Error("That is not a link.", { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https links can be fetched.");
  const headers = { accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5", "user-agent": "sshS3-knowledge-base" };
  let response: Response;
  for (let hop = 0; ; hop++) {
    if (hop > 5) throw new Error("The link redirects too many times.");
    // Checked before it is called. This throws in words a person can act on.
    const target = guard
      ? await guardUrl(parsed.toString(), guard).catch((error: unknown) => {
          throw new Error(error instanceof Error ? error.message : "The link could not be checked.", { cause: error });
        })
      : undefined;
    try {
      if (fetchImpl || !target) {
        response = await (fetchImpl ?? fetch)(parsed.toString(), { redirect: "manual", signal: AbortSignal.timeout(25_000), headers });
      } else {
        const got = await get(target, headers, MAX_UPLOAD_BYTES);
        response = new Response(got.status === 204 || got.status === 304 || (got.status >= 300 && got.status < 400) ? null : new Uint8Array(got.data), {
          status: got.status,
          headers: Object.entries(got.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]])),
        });
      }
    } catch (error) {
      throw new Error(`The link could not be reached (${error instanceof Error ? error.message : "no answer"}).`, {
        cause: error,
      });
    }
    const next = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!next) break;
    try {
      parsed = new URL(next, parsed);
    } catch (error) {
      throw new Error("The link redirects to something that is not a link.", { cause: error });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http and https links can be fetched.");
  }
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? `The page needs a login (HTTP ${response.status}). Save it as a file and drop that in instead.`
        : `The link answered HTTP ${response.status}.`,
    );
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new Error("The page is too large.");
  const data = Buffer.from(await response.arrayBuffer());
  const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  const name = path.basename(parsed.pathname) || parsed.hostname;
  if (mime.includes("html") || /^\s*<(!doctype html|html)/i.test(data.subarray(0, 200).toString("latin1"))) {
    const { text, title } = await htmlToMarkdown(data.toString("utf8"), parsed.toString());
    if (text.length < 40) throw new Error("The page has no readable text. It may be drawn by script, or need a login.");
    return { text, format: "html", title, url: parsed.toString() };
  }
  return { ...(await extractText({ name, mime, data })), url: parsed.toString() };
}

export interface Section {
  /** Where in the document this is: the headings above it, outermost first. */
  heading?: string;
  text: string;
}

/**
 * Cuts a document into the pieces search returns. A piece follows the
 * document's own structure: it starts at a heading, a fenced code block or a
 * table is never cut in two, and every piece knows the headings it sits
 * under. A short document is one piece, unchanged.
 */
export function splitSections(text: string, maxChars = 1600): Section[] {
  const cleaned = text.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) return [];
  // Short, or without headings to follow: one piece.
  const headingCount = (cleaned.match(/^#{1,6}\s+\S/gm) ?? []).length;
  if (cleaned.length <= 700 || (cleaned.length <= maxChars && headingCount < 2))
    return [{ text: cleaned, heading: firstHeading(cleaned) }];

  // 1. Blocks that must stay whole: a heading line, a code fence, a table, a paragraph.
  const blocks: Array<{ kind: "heading" | "body"; text: string; level?: number; title?: string }> = [];
  const lines = cleaned.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const start = i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) i++;
      i = Math.min(lines.length, i + 1);
      blocks.push({ kind: "body", text: lines.slice(start, i).join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", text: line, level: heading[1].length, title: heading[2].replace(/[*`]/g, "").trim() });
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const start = i;
    const table = line.trimStart().startsWith("|");
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      (table ? lines[i].trimStart().startsWith("|") : !lines[i].trimStart().startsWith("|") || i === start)
    )
      i++;
    blocks.push({ kind: "body", text: lines.slice(start, i).join("\n") });
  }

  // 2. Pieces: filled up to the size, closed at a heading.
  const out: Section[] = [];
  const trail: Array<{ level: number; title: string }> = [];
  let current: string[] = [];
  let currentHeading: string | undefined;
  /** The headings the piece being filled started under. */
  let pieceHeading: string | undefined;
  let size = 0;
  const close = (): void => {
    const body = current.join("\n\n").trim();
    // A heading with nothing under it is carried into the next piece instead.
    if (body && !/^#{1,6}\s+[^\n]*$/.test(body)) out.push({ heading: pieceHeading, text: body });
    else if (body) pendingHeading = body;
    current = [];
    size = 0;
  };
  let pendingHeading = "";
  const push = (block: string): void => {
    if (pendingHeading) {
      current.push(pendingHeading);
      size += pendingHeading.length;
      pendingHeading = "";
    }
    if (current.length === 0) pieceHeading = currentHeading;
    current.push(block);
    size += block.length + 2;
  };
  for (const block of blocks) {
    if (block.kind === "heading") {
      // A section of a few lines stays with what follows it; a real one ends here.
      if (size >= 300) close();
      while (trail.length && trail[trail.length - 1].level >= block.level!) trail.pop();
      trail.push({ level: block.level!, title: block.title! });
      currentHeading = trail.map((t) => t.title).join(" › ");
      push(block.text);
      continue;
    }
    if (size > 0 && size + block.text.length > maxChars) close();
    if (block.text.length > maxChars * 2.5) {
      // One block far larger than a piece (a long log, a huge table): cut it by lines.
      let part: string[] = [];
      let partSize = 0;
      for (const l of block.text.split("\n")) {
        if (partSize + l.length > maxChars && part.length) {
          push(part.join("\n"));
          close();
          part = [];
          partSize = 0;
        }
        part.push(l.length > maxChars ? l.slice(0, maxChars) : l);
        partSize += l.length + 1;
      }
      if (part.length) push(part.join("\n"));
      continue;
    }
    push(block.text);
  }
  close();
  if (pendingHeading && out.length) out[out.length - 1].text += `\n\n${pendingHeading}`;
  return out.length ? out : [{ text: cleaned }];
}

/** A text too long for one document, as parts cut where a paragraph ends. */
export function splitLongText(text: string, maxChars = MAX_DOC_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut = Math.max(window.lastIndexOf("\n# "), window.lastIndexOf("\n## "), window.lastIndexOf("\n\n"));
    const at = cut > maxChars * 0.5 ? cut : maxChars;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
