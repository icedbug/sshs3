import { maskSecrets } from "./privacy";

/** Where a private key starts, as `maskSecrets` finds one: a PEM key (group 1) or a PGP key block. */
const KEY_BEGIN = /-----BEGIN (?:([A-Z0-9 ]*PRIVATE KEY)|PGP PRIVATE KEY BLOCK)-----/;
const PEM_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const PGP_KEY_END = /-----END PGP PRIVATE KEY BLOCK-----/;
/** A line of a key's body: base64, or blank. */
const KEY_BODY_LINE = /^[ \t]*[A-Za-z0-9+/=]*[ \t]*\r?$/;
/** A header line before a key's body: `Proc-Type: 4,ENCRYPTED`, `Version: …`. */
const KEY_HEADER_LINE = /^[A-Za-z][\w-]{0,40}:.*$/;
const KEY_PLACEHOLDER = "[private key redacted]";
/**
 * The line that starts a `chpasswd` heredoc, found as privacy.ts `CHPASSWD_HEREDOC` finds it, and
 * the word that ends it. The lines in between are `name:password`.
 */
const CHPASSWD_HEAD = /\bchpasswd\b[^\n]{0,80}<<-?[ \t]*["']?(\w{1,40})["']?[^\n]{0,80}\n/;
const HEREDOC_PASSWORD = /^([ \t]*[\w.@-]{1,64}:)\S+/;
/**
 * The line being written is held back until it ends, up to this many characters. A line of prose is
 * often a whole paragraph: past this length it is shown in parts as it grows.
 */
const LINE_HOLD = 512;
/** Of a line longer than LINE_HOLD, at least this much of its end is still held back. */
const TAIL_HOLD = 256;
/** About this much of what was passed on is masked again with what follows it. */
const CONTEXT_CHARS = 1_024;

/**
 * Masks an answer while it streams, before any of it reaches the screen. A secret often arrives
 * in several pieces, and whether text is one can depend on what follows it on the same line
 * (`mysql … -pSECRET`, the last part of a JWT, `"auth": "…"` once its quote closes). So the line
 * being written is held back until it ends, and each line is masked together with the lines just
 * before it: `password:` at the end of one line still masks the value on the next. The answer
 * therefore appears line by line. A line longer than LINE_HOLD is passed on in parts, cut at a
 * space outside quotes, with its last TAIL_HOLD characters held back.
 *
 * Two things span many lines and are followed on their own. A private key: from its BEGIN line
 * on, only `[private key redacted]` is passed on, however long the key is, up to its END line.
 * The lines of a `chpasswd` heredoc: each is passed on with its password masked.
 *
 * What is passed on is, piece by piece, what masking the whole text gives. Where what came later
 * changes how text already passed on is masked (`Bearer` at the end of one line and its token on
 * the next), that text cannot be taken back: the masked text is passed on from where the two
 * differ, so the secret is still not shown.
 */
export class StreamingSecretMasker {
  /** Text that came and was not passed on yet. */
  private pending = "";
  /** The end of what was passed on, as it came: it is masked again with what follows it. */
  private context = "";
  /** What was passed on for `context`. */
  private contextShown = "";
  /** A private key is being written: nothing of it is passed on. */
  private key?: { end: RegExp; pgp: boolean; first: boolean; body: boolean; held: string };
  /** The lines of a `chpasswd` heredoc are being written, up to the line that starts with this word. */
  private heredocEnd?: string;
  /** How long `pending` may grow without a line break before it is looked at again. */
  private checkAt = LINE_HOLD;

  constructor(private readonly mask: (text: string) => string = maskSecrets) {}

  static forAnswer(mask: (text: string) => string): StreamingSecretMasker {
    return new StreamingSecretMasker(mask);
  }

  /** A copy that goes on from where this one is. A turn that is asked again starts from the same point. */
  clone(): StreamingSecretMasker {
    const copy = new StreamingSecretMasker(this.mask);
    copy.pending = this.pending;
    copy.context = this.context;
    copy.contextShown = this.contextShown;
    copy.key = this.key && { ...this.key };
    copy.heredocEnd = this.heredocEnd;
    copy.checkAt = this.checkAt;
    return copy;
  }

  /** A piece of the answer came. Returns what can be shown now, masked; often nothing. */
  push(chunk: string): string {
    if (!chunk) return "";
    this.pending += chunk;
    if (!chunk.includes("\n") && this.pending.length < this.checkAt) return "";
    return this.drain(false);
  }

  /** The answer has ended: what is still held back is passed on, masked. */
  flush(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let out = "";
    for (;;) {
      if (this.key) {
        if (this.drainKey(final)) continue;
        break;
      }
      const step = this.heredocEnd !== undefined ? this.drainHeredoc(final) : this.drainText(final);
      out += step.out;
      if (!step.again) break;
    }
    this.checkAt = this.key || this.heredocEnd !== undefined || this.pending.length < LINE_HOLD
      ? Math.max(LINE_HOLD, this.pending.length + LINE_HOLD)
      : this.pending.length + Math.max(512, this.pending.length >> 2);
    return out;
  }

  private drainText(final: boolean): { out: string; again: boolean } {
    const pending = this.pending;
    const lineEnd = final ? pending.length : pending.lastIndexOf("\n") + 1;
    const begin = KEY_BEGIN.exec(pending);
    const head = CHPASSWD_HEAD.exec(pending.slice(0, lineEnd));
    if (begin && (!head || begin.index < head.index)) {
      // What comes before the key is passed on; the key itself becomes the placeholder at once.
      const out = this.emit(pending.slice(0, begin.index)) + KEY_PLACEHOLDER;
      this.pending = pending.slice(begin.index + begin[0].length);
      this.key = { end: begin[1] ? PEM_KEY_END : PGP_KEY_END, pgp: !begin[1], first: true, body: false, held: "" };
      this.context = this.contextShown = "";
      return { out, again: true };
    }
    if (head) {
      const at = head.index + head[0].length;
      const out = this.emit(pending.slice(0, at));
      this.pending = pending.slice(at);
      this.heredocEnd = head[1];
      return { out, again: true };
    }
    let out = this.emit(pending.slice(0, lineEnd));
    let rest = pending.slice(lineEnd);
    if (rest.length > LINE_HOLD) {
      const cut = this.safeCut(rest);
      if (cut > 0) {
        out += this.emit(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
    }
    this.pending = rest;
    return { out, again: false };
  }

  /**
   * Where a line too long to hold back whole can be cut, or 0: at a space, so that no word (a
   * token, a key, a URL) is cut in two; before a quote that is still open; and only where masking
   * the line up to the cut gives the start of masking all of it.
   */
  private safeCut(line: string): number {
    let cut = line.length - TAIL_HOLD;
    while (cut > 0 && !/\s/.test(line[cut - 1])) cut--;
    const lineSoFar = this.context.slice(this.context.lastIndexOf("\n") + 1);
    for (let round = 0; round < 4 && cut > 0; round++) {
      let moved = false;
      for (const quote of ['"', "'"]) {
        const quotes = (lineSoFar + line.slice(0, cut)).split(quote).length - 1;
        if (quotes % 2 === 0) continue;
        cut = Math.max(0, line.lastIndexOf(quote, cut - 1));
        moved = true;
      }
      if (!moved) break;
    }
    if (cut <= 0) return 0;
    const whole = this.mask(this.context + line);
    return whole.startsWith(this.mask(this.context + line.slice(0, cut))) ? cut : 0;
  }

  /** Masks `text` together with what was passed on before it; returns what is new to show. */
  private emit(text: string): string {
    if (!text) return "";
    const whole = this.context + text;
    const masked = this.mask(whole);
    let from = this.contextShown.length;
    if (!masked.startsWith(this.contextShown)) {
      from = 0;
      while (from < this.contextShown.length && masked[from] === this.contextShown[from]) from++;
    }
    this.context = whole;
    this.contextShown = masked;
    if (whole.length > 2 * CONTEXT_CHARS) {
      // Kept from the start of a line, so that a rule that reads a whole line still has it.
      let at = whole.lastIndexOf("\n", whole.length - CONTEXT_CHARS) + 1;
      if (whole.length - at > 8 * CONTEXT_CHARS) {
        at = whole.length - 8 * CONTEXT_CHARS;
        while (at < whole.length && !/\s/.test(whole[at - 1])) at++;
      }
      this.context = whole.slice(at);
      this.contextShown = this.mask(this.context);
    }
    return masked.slice(from);
  }

  /** In a private key. Returns true when the key has ended and the text after it is to be read. */
  private drainKey(final: boolean): boolean {
    const key = this.key!;
    const end = key.end.exec(this.pending);
    if (end) {
      // Masked from BEGIN to END as one: nothing of it, nor anything held back inside it, is shown.
      this.pending = this.pending.slice(end.index + end[0].length);
      this.key = undefined;
      return true;
    }
    for (;;) {
      // The rest of the BEGIN line first, then each line with the line break before it.
      const nl = this.pending.indexOf("\n", key.first ? 0 : 1);
      if (nl < 0 && !final) return false;
      const unit = nl < 0 ? this.pending : this.pending.slice(0, nl);
      if (!unit && !key.first) break;
      this.pending = this.pending.slice(unit.length);
      const line = key.first ? unit : unit.slice(1);
      const first = key.first;
      key.first = false;
      if (!key.held) {
        if (KEY_BODY_LINE.test(line)) {
          if (line.trim()) key.body = true;
          continue;
        }
        if (!first && !key.body && KEY_HEADER_LINE.test(line)) continue;
        // Text after the BEGIN marker on its own line: the marker was named, no key follows it.
        if (first && !key.pgp) {
          this.key = undefined;
          this.pending = unit + this.pending;
          return true;
        }
      }
      // A PGP key block is masked up to its END, or to the end of the text when it has none.
      if (key.pgp) continue;
      // Lines that are not a key's: held back while its END may still come.
      key.held += unit;
      if (key.held.length > LINE_HOLD || nl < 0) break;
    }
    this.key = undefined;
    if (key.pgp) {
      this.pending = "";
      return false;
    }
    this.pending = key.held + this.pending;
    return true;
  }

  /** In a `chpasswd` heredoc: each line is passed on with its password masked, up to the end word. */
  private drainHeredoc(final: boolean): { out: string; again: boolean } {
    let out = "";
    for (;;) {
      const nl = this.pending.indexOf("\n");
      if (nl < 0 && !(final && this.pending)) return { out, again: false };
      const line = nl < 0 ? this.pending : this.pending.slice(0, nl + 1);
      const word = line.replace(/^[ \t]*/, "");
      if (word.startsWith(this.heredocEnd!) && !/\w/.test(word.charAt(this.heredocEnd!.length))) {
        this.heredocEnd = undefined;
        this.context = this.contextShown = "";
        return { out, again: true };
      }
      this.pending = this.pending.slice(line.length);
      out += this.mask(line.replace(HEREDOC_PASSWORD, "$1[redacted]"));
    }
  }
}
