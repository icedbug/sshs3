import type { ChatServiceName } from '../../../shared/types/aiHub';
import type { RunView } from '../../ai/hub/areas/chatRuns';
import { maskContext } from '../../ai/hub/privacy';
import type { MattermostAttachment, SlackBlock } from './AgentBotApi';

/**
 * How the agent bot's posts look in Slack and Mattermost. Everything here is pure: it takes what the
 * hub stored (runView, the stored approval text) and returns what AgentBotApi sends.
 *
 * Every text is masked once more here, and then made harmless for the chat: in Slack `&`, `<` and `>`
 * are escaped, so a model that writes `<!channel>` or `<@U123>` shows those characters and pings
 * nobody; in Mattermost an `@` that starts a word gets a zero width joiner after it, so `@all` or a
 * person's name is shown and not called. Masking strips invisible characters, so it must never run
 * after this: the joiner would go and the mention would work again.
 *
 * Cards show the whole command, check and rollback as stored for approval. A card that cannot be shown
 * whole gets no buttons, only a line to answer in sshs3: nothing is cut short and then approved.
 */

/** Slack lets a section hold 3000 characters: a little room is kept. */
export const SLACK_SECTION_MAX = 2900;
/** Slack allows 50 blocks per message: room is kept for a header and buttons. */
export const SLACK_BLOCKS_MAX = 45;
/** Mattermost's default post size is 16383 characters. */
export const MATTERMOST_POST_MAX = 15_000;
/** More than this is not posted in a thread: the rest is read in sshs3. */
export const ANSWER_MAX = 12_000;
/** A card longer than this is answered in sshs3. */
export const CARD_MAX = 12_000;
const SLACK_FALLBACK_MAX = 300;
const SLACK_HEADER_MAX = 150;
const ZWJ = '\u200D';

/** The button action ids. The value of each is the signed token (chatActionToken). */
export const SLACK_APPROVE_ACTION = 'sshs3_approve';
export const SLACK_DENY_ACTION = 'sshs3_deny';
/** Mattermost action ids may hold only letters and digits. */
export const MATTERMOST_APPROVE_ACTION = 'sshs3approve';
export const MATTERMOST_DENY_ACTION = 'sshs3deny';
/** Without a public address, a Mattermost card is answered with these reactions. */
export const REACTION_APPROVE = 'white_check_mark';
export const REACTION_DENY = 'x';

export const RESTARTED_TEXT = 'Stopped: the server restarted. Reply to go on.';

export interface SlackOut {
  service: 'slack';
  /** The text a notification shows. With blocks, Slack shows the blocks in the thread. */
  text: string;
  blocks?: SlackBlock[];
}
export interface MattermostOut {
  service: 'mattermost';
  message: string;
  /** Buttons live in attachments. An empty list takes old buttons away on an edit. */
  attachments?: MattermostAttachment[];
}
export type ChatOut = SlackOut | MattermostOut;

export interface ChatLinkRef {
  url: string;
  label: string;
}

// -------------------------------------------------------------------------------------------------
// Splitting
// -------------------------------------------------------------------------------------------------

interface Unit {
  kind: 'text' | 'code';
  lines: string[];
  /** The fence's first line, as written (```bash). */
  open?: string;
  /** The mark that closes this block: the opening run of backticks or tildes. */
  fence?: string;
}

/** A fence opens with three or more backticks or tildes, indented at most three spaces, as CommonMark reads it. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** The closing mark of a fence this line opens, or undefined when it opens none. */
function fenceOpened(line: string): string | undefined {
  const m = FENCE_OPEN.exec(line);
  if (!m) return undefined;
  // A backtick fence's info string holds no backtick: ```ls``` on one line is text with code in it.
  if (m[1][0] === '`' && m[2].includes('`')) return undefined;
  return m[1];
}

/** Whether this line closes a block opened with `fence`: the same mark, at least as long, and nothing after it. */
function fenceCloses(line: string, fence: string): boolean {
  const m = FENCE_CLOSE.exec(line);
  return Boolean(m && m[1][0] === fence[0] && m[1].length >= fence.length);
}

/** Paragraphs and code blocks. A code block keeps its blank lines; one left open is closed on output. */
function units(text: string): Unit[] {
  const out: Unit[] = [];
  let para: string[] = [];
  let code: Unit | undefined;
  const flush = (): void => {
    if (para.length) out.push({ kind: 'text', lines: para });
    para = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (code) {
      if (fenceCloses(line, code.fence ?? '```')) {
        out.push(code);
        code = undefined;
      } else code.lines.push(line);
      continue;
    }
    const fence = fenceOpened(line);
    if (fence) {
      flush();
      code = { kind: 'code', open: line.trim(), fence, lines: [] };
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  if (code) out.push(code);
  return out;
}

const unitText = (u: Unit): string => (u.kind === 'code' ? [u.open ?? '```', ...u.lines, u.fence ?? '```'].join('\n') : u.lines.join('\n'));

/**
 * Where a hard cut may fall: not inside an escaped character (&amp;), a Slack link (<url|text>) or a
 * pair of UTF-16 halves.
 */
function safeCut(s: string, max: number): number {
  let cut = max;
  const amp = s.lastIndexOf('&', cut - 1);
  if (amp > 0 && cut - amp < 8 && !s.slice(amp, cut).includes(';')) cut = amp;
  const lt = s.lastIndexOf('<', cut - 1);
  if (lt > 0 && cut - lt < 400) {
    const gt = s.indexOf('>', lt);
    if (gt === -1 || gt >= cut) cut = lt;
  }
  if (cut > 1 && /[\uD800-\uDBFF]/.test(s[cut - 1])) cut--;
  return cut > 0 ? cut : max;
}

/** A line too long for one piece: at a space when one is near the end, otherwise where it is safe. */
function breakLine(line: string, max: number, code: boolean): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    const space = code ? -1 : rest.lastIndexOf(' ', max);
    const cut = space > max / 2 ? space : safeCut(rest, max);
    out.push(rest.slice(0, cut));
    rest = code ? rest.slice(cut) : rest.slice(cut).replace(/^ /, '');
  }
  out.push(rest);
  return out;
}

function packLines(lines: string[], max: number, code: boolean): string[] {
  const out: string[] = [];
  let current: string | undefined;
  for (const line of lines) {
    for (const part of line.length <= max ? [line] : breakLine(line, max, code)) {
      if (current === undefined) current = part;
      else if (current.length + 1 + part.length <= max) current += `\n${part}`;
      else {
        out.push(current);
        current = part;
      }
    }
  }
  if (current !== undefined) out.push(current);
  return out;
}

function breakUnit(u: Unit, max: number): string[] {
  const whole = unitText(u);
  if (whole.length <= max) return [whole];
  if (u.kind === 'text') return packLines(u.lines, max, false);
  // A code block over several pieces: each piece is a whole block of its own, opened and closed.
  const open = u.open ?? '```';
  const fence = u.fence ?? '```';
  const room = max - open.length - fence.length - 2;
  if (room < 20) return packLines(whole.split('\n'), max, true);
  return packLines(u.lines, room, true).map((body) => `${open}\n${body}\n${fence}`);
}

/**
 * Splits a text into pieces of at most `max` characters, at paragraphs, never inside a code block: a
 * block that is too long becomes several blocks, each opened and closed.
 */
export function splitAtParagraphs(text: string, max: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const u of units(text)) {
    for (const piece of breakUnit(u, max)) {
      if (!current) current = piece;
      else if (current.length + 2 + piece.length <= max) current += `\n\n${piece}`;
      else {
        pieces.push(current);
        current = piece;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

// -------------------------------------------------------------------------------------------------
// Making text harmless
// -------------------------------------------------------------------------------------------------

/** Slack reads `&`, `<` and `>` as markup: `<!channel>` and `<@U123>` call people. Escaped, they are just text. */
export function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s()<>|]{1,2000})\)/g;

function slackStyle(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '*$1*')
    .replace(/__(?=\S)([^_\n]+?)__/g, '_$1_')
    .replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~');
}

/** Prose outside code: Markdown links, bold and strike as Slack writes them, everything else escaped. */
function slackProse(segment: string): string {
  let out = '';
  let last = 0;
  for (const m of segment.matchAll(LINK)) {
    const at = m.index ?? 0;
    out += slackStyle(slackEscape(segment.slice(last, at)));
    out += `<${m[2].replace(/&/g, '&amp;')}|${slackEscape(m[1])}>`;
    last = at + m[0].length;
  }
  return out + slackStyle(slackEscape(segment.slice(last)));
}

/** One line: inline code kept as it is (escaped only), headings bold, list marks as bullets. */
function slackLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  const inline = (s: string): string =>
    s
      .split(/(`[^`\n]+`)/)
      .map((seg, i) => (i % 2 ? slackEscape(seg) : slackProse(seg)))
      .join('');
  if (heading) return `*${inline(heading[1].replace(/\*\*/g, ''))}*`;
  if (bullet) return `${bullet[1]}• ${inline(bullet[2])}`;
  return inline(line);
}

/**
 * Markdown as the model writes it, in Slack's own markup. Code blocks lose their language tag (Slack
 * would show it as text) and are escaped only.
 */
export function toSlackMrkdwn(text: string): string {
  return units(text)
    .map((u) => (u.kind === 'code' ? ['```', ...u.lines.map(slackEscape), '```'].join('\n') : u.lines.map(slackLine).join('\n')))
    .join('\n\n');
}

/**
 * Every `@` in front of a name gets a zero width joiner: `@all`, `_@channel_` and `@maria` call nobody.
 * Nothing in front of it is trusted to stop a mention: Mattermost trims marks such as `_` and `.` off a
 * word before it looks for one. An e-mail address in prose loses its link; that costs little.
 */
const defuseAt = (s: string): string => s.replace(/@(?=[A-Za-z0-9_.-])/g, `@${ZWJ}`);

/** Code that may be copied keeps `user@host` and `git@github.com` whole; an `@` that starts a word is still made harmless. */
const defuseInCode = (s: string): string => s.replace(/(?<![\p{L}\p{N}])@(?=[A-Za-z0-9_.-])/gu, `@${ZWJ}`);

/**
 * A run of three backticks or tildes in text is broken up with joiners: in a line of prose it could open a
 * code block, and the code block of a card or an answer after it would then be read as text.
 */
const breakFences = (s: string): string => s.replace(/[`~]{3,}/g, (m) => [...m].join(ZWJ));

/** Inline code both Markdown and Mattermost's own mention check read as code: one backtick each side, none next to them. */
const INLINE_CODE = /((?<!`)`[^`\n]+`(?!`))/;
/** A line that Mattermost could read as the start or end of a code block, whatever CommonMark says. */
const FENCE_LIKE = /^[^\S\n]*[`~]{3}/;

/**
 * Mentions made harmless. A command in a code block must stay as it is to be copied, and Mattermost calls
 * nobody from code. But CommonMark and Mattermost's own mention check do not find code quite alike, so
 * what is kept as code is what both read as code: a block is written out again with plain ``` fences, a
 * block that holds a line either could read as a fence is treated as text, and a run of three fence
 * marks in text is broken up so it opens nothing. Inline code is paired less alike still, so in it only
 * an `@` inside a word (`user@host`) is kept. An image is shown as a link: the reader's app would
 * otherwise fetch its address by itself, and an address can carry data out.
 */
export function mattermostDefuse(text: string): string {
  const prose = (line: string): string =>
    breakFences(line)
      .split(INLINE_CODE)
      .map((seg, i) => (i % 2 ? defuseInCode(seg) : defuseAt(seg.replace(/!\[([^\]\n]*)\]\(/g, '[$1]('))))
      .join('');
  return units(text)
    .map((u) => {
      if (u.kind === 'code' && !u.lines.some((l) => FENCE_LIKE.test(l))) {
        const info = (u.open ?? '').replace(/^\s*[`~]+/, '').trim();
        const plainInfo = /^[A-Za-z0-9_+.#-]{1,30}$/.test(info) ? info : '';
        return ['```' + plainInfo, ...u.lines, '```'].join('\n');
      }
      const lines = u.kind === 'code' ? [u.open ?? '```', ...u.lines, u.fence ?? '```'] : u.lines;
      return lines.map(prose).join('\n');
    })
    .join('\n\n');
}

/** A plain line of text for Mattermost (a name, a reason): mentions and images made harmless. */
const mmPlain = (s: string): string => defuseAt(breakFences(s.replace(/!\[/g, '[')));

const SAFE_URL = /^https?:\/\/[^\s<>|()]+$/;

function slackLinkRef(link: ChatLinkRef | undefined): string {
  if (!link || !SAFE_URL.test(link.url)) return '';
  return `<${link.url.replace(/&/g, '&amp;')}|${slackEscape(link.label)}>`;
}

function mmLinkRef(link: ChatLinkRef | undefined): string {
  if (!link || !SAFE_URL.test(link.url)) return '';
  return `[${mmPlain(link.label).replace(/[[\]]/g, '')}](${link.url})`;
}

// -------------------------------------------------------------------------------------------------
// Answers and short messages
// -------------------------------------------------------------------------------------------------

/**
 * The final answer of a run, ready to post: masked again, cut at a paragraph after about 12000
 * characters with a line that the rest is in sshs3, and split into as many messages as it takes.
 * Give it the stored text (runView), never pieces of the model's stream.
 */
export function formatAnswer(service: ChatServiceName, stored: string, options: { link?: ChatLinkRef; max?: number } = {}): ChatOut[] {
  const masked = maskContext(stored).trim();
  const cap = options.max ?? ANSWER_MAX;
  let text = masked || 'I have nothing to add.';
  let cut = false;
  if (text.length > cap) {
    text = splitAtParagraphs(text, cap)[0] ?? text.slice(0, cap);
    cut = true;
  }
  const rest = cut ? chatText.restInApp() : '';
  if (service === 'slack') {
    const sections = splitAtParagraphs(toSlackMrkdwn(text), SLACK_SECTION_MAX);
    if (rest) sections.push(`_${slackEscape(rest)}_${options.link ? ` ${slackLinkRef(options.link)}` : ''}`);
    const out: SlackOut[] = [];
    for (let i = 0; i < sections.length; i += SLACK_BLOCKS_MAX) {
      const group = sections.slice(i, i + SLACK_BLOCKS_MAX);
      out.push({
        service: 'slack',
        text: fallbackText(group[0]),
        blocks: group.map((s) => ({ type: 'section', text: { type: 'mrkdwn', text: s } })),
      });
    }
    return out;
  }
  const posts = splitAtParagraphs(mattermostDefuse(text), MATTERMOST_POST_MAX);
  if (rest) {
    const line = `_${mmPlain(rest)}_${options.link ? ` ${mmLinkRef(options.link)}` : ''}`;
    const last = posts.length - 1;
    if (last >= 0 && posts[last].length + 2 + line.length <= MATTERMOST_POST_MAX) posts[last] += `\n\n${line}`;
    else posts.push(line);
  }
  return posts.map((message) => ({ service: 'mattermost', message }));
}

/** What a Slack notification shows: the start of the message, with no code fence marks. */
function fallbackText(slackText: string): string {
  const flat = slackText.replace(/```/g, '').replace(/\s+/g, ' ').trim();
  if (flat.length <= SLACK_FALLBACK_MAX) return flat;
  return `${flat.slice(0, safeCut(flat, SLACK_FALLBACK_MAX - 1)).trimEnd()}…`;
}

/** A short plain message (a status line, a reply, a reason), with a link when one is known. */
export function note(service: ChatServiceName, text: string, link?: ChatLinkRef): ChatOut {
  const masked = maskContext(text).trim();
  if (service === 'slack') {
    const ref = slackLinkRef(link);
    return { service, text: `${slackEscape(masked)}${ref ? ` ${ref}` : ''}` };
  }
  const ref = mmLinkRef(link);
  return { service, message: `${mmPlain(masked)}${ref ? ` ${ref}` : ''}` };
}

// -------------------------------------------------------------------------------------------------
// Cards
// -------------------------------------------------------------------------------------------------

type Segment = { text: string } | { code: string; lang?: string };
interface Part {
  label?: string;
  segments: Segment[];
}

export type CardChange = RunView['pending'][number];
export type CardPlan = NonNullable<RunView['plan']>;
type Vote = CardChange['approvals'][number];

export interface CardButtons {
  /** The signed value of the Approve button. */
  approve: string;
  /** The signed value of the Deny button. */
  deny: string;
  /**
   * Mattermost: where its buttons send a press, when the server has a public address. Without one,
   * people answer a Mattermost card with a reaction, and the card says so.
   */
  mattermostUrl?: string;
}

/** How a card ended: it takes no more answers and shows no buttons. */
export type CardOutcome =
  | { state: 'approved' | 'denied'; by: string[]; via?: ChatServiceName | 'app' }
  | { state: 'stopped' | 'expired' | 'restarted' | 'replaced' };

export interface CardOptions {
  /** Who the channel lets answer, as the run's fence says. */
  approvers: 'linked' | 'admins';
  /** What it touches is production. */
  production?: boolean;
  /** Where it is answered in sshs3. */
  link?: string;
  /** The signed buttons. Absent: no buttons yet, and the card says to answer in sshs3. */
  buttons?: CardButtons;
  /** The card is done: shows the outcome, no buttons. */
  final?: CardOutcome;
}

export interface CardOut {
  slack: SlackOut;
  mattermost: MattermostOut;
  /** Whether the whole card fit. One that did not was drawn short, with no buttons. */
  fits: { slack: boolean; mattermost: boolean };
  /**
   * Whether the card can be answered in the chat as drawn: it fit whole, it is not answered only in the
   * app, it has not ended, and it was given buttons. Only such a card takes a press or a reaction.
   */
  answerable: { slack: boolean; mattermost: boolean };
}

const SERVICE_LABEL: Record<string, string> = { slack: 'Slack', mattermost: 'Mattermost', app: 'sshs3' };

function names(list: string[]): string {
  const clean = list.map((n) => n.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? 'somebody';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

function viaLabel(via: string | undefined): string {
  return via ? ` in ${SERVICE_LABEL[via] ?? 'sshs3'}` : '';
}

export function outcomeText(outcome: CardOutcome): string {
  switch (outcome.state) {
    case 'approved':
      return `Approved by ${names(outcome.by)}${viaLabel(outcome.via)}.`;
    case 'denied':
      return `Denied by ${names(outcome.by)}${viaLabel(outcome.via)}. It does not run.`;
    case 'stopped':
      return 'Stopped. Nothing more runs from this card.';
    case 'expired':
      return 'Expired: nobody answered in time, so it did not run.';
    case 'restarted':
      return RESTARTED_TEXT;
    case 'replaced':
      return 'Replaced by a newer plan below.';
  }
}

function approvalsText(required: number, votes: Vote[]): string {
  const yes = votes.filter((v) => v.allowed);
  const no = votes.filter((v) => !v.allowed);
  const people = (list: Vote[]): string => names(list.map((v) => `${v.actor}${viaLabel(v.via)}`));
  const need = Math.max(1, required);
  let line =
    yes.length === 0
      ? `Approvals: none yet. ${need === 1 ? 'One person' : `${need} people`} must approve.`
      : `Approvals: ${yes.length} of ${need}. Approved by ${people(yes)}.`;
  if (no.length) line += ` Denied by ${people(no)}.`;
  return line;
}

function whoMayText(options: CardOptions): string {
  const who =
    options.approvers === 'admins'
      ? 'Who may approve: sshs3 administrators who linked their chat account.'
      : 'Who may approve: people who linked their chat account to sshs3, and may approve this in sshs3.';
  return options.production ? `${who} This is production, so only people allowed to approve changes there can.` : who;
}

const RISK_TEXT: Record<string, string> = {
  safe: 'Low. It only reads.',
  modify: 'It changes something.',
  destructive: 'High. It can remove or overwrite data.',
};

const STEP_RISK: Record<string, string> = { low: 'low', medium: 'medium', high: 'high' };

function renderSlackPart(part: Part): string {
  const body = part.segments
    .map((s) => ('code' in s ? `\`\`\`\n${slackEscape(s.code)}\n\`\`\`` : slackEscape(s.text)))
    .join('\n');
  return part.label ? `*${slackEscape(part.label)}*\n${body}` : body;
}

function renderMattermostPart(part: Part): string {
  const body = part.segments.map((s) => ('code' in s ? `\`\`\`${s.lang ?? ''}\n${s.code}\n\`\`\`` : mmPlain(s.text))).join('\n');
  return part.label ? `**${mmPlain(part.label)}**\n${body}` : body;
}

/**
 * A code field that holds a fence mark could break out of its block, and what follows would be read as
 * text, mentions and all. Mattermost's own mention check also ends a block at ~~~ or a mix of the two
 * marks, so any run of three is refused: such a card is answered in sshs3.
 */
function codeIsSafe(parts: Part[]): boolean {
  return parts.every((p) => p.segments.every((s) => !('code' in s) || !/[`~]{3}/.test(s.code)));
}

function slackButtons(buttons: CardButtons, confirm: { title: string; text: string } | undefined): SlackBlock {
  const confirmDialog = confirm
    ? {
        confirm: {
          title: { type: 'plain_text', text: confirm.title.slice(0, 100) },
          text: { type: 'plain_text', text: confirm.text.slice(0, 300) },
          confirm: { type: 'plain_text', text: 'Approve' },
          deny: { type: 'plain_text', text: 'Back' },
        },
      }
    : {};
  return {
    type: 'actions',
    elements: [
      { type: 'button', action_id: SLACK_APPROVE_ACTION, text: { type: 'plain_text', text: 'Approve' }, style: 'primary', value: buttons.approve, ...confirmDialog },
      { type: 'button', action_id: SLACK_DENY_ACTION, text: { type: 'plain_text', text: 'Deny' }, style: 'danger', value: buttons.deny },
    ],
  };
}

function mattermostButtons(buttons: CardButtons): MattermostAttachment[] {
  if (!buttons.mattermostUrl || !SAFE_URL.test(buttons.mattermostUrl)) return [];
  const action = (id: string, name: string, style: string, token: string) => ({
    id,
    name,
    type: 'button',
    style,
    integration: { url: buttons.mattermostUrl, context: { t: token } },
  });
  return [
    {
      fallback: 'Approve or deny',
      actions: [action(MATTERMOST_APPROVE_ACTION, 'Approve', 'primary', buttons.approve), action(MATTERMOST_DENY_ACTION, 'Deny', 'danger', buttons.deny)],
    },
  ];
}

interface CardSpec {
  title: string;
  /** The whole card. */
  parts: Part[];
  /** What is shown when the whole card does not fit: enough to know what it is. */
  short: Part[];
  /** Answered only in sshs3, whatever its size. */
  appOnly?: string;
  /** Slack asks "are you sure" before Approve sends. */
  confirm?: { title: string; text: string };
}

function buildCard(spec: CardSpec, options: CardOptions): CardOut {
  const link = options.link ? { url: options.link, label: 'Open in sshs3' } : undefined;
  const final = options.final ? outcomeText(options.final) : undefined;
  const header = maskContext(spec.title).slice(0, SLACK_HEADER_MAX);
  const mask = (parts: Part[]): Part[] =>
    parts.map((p) => ({
      ...(p.label ? { label: maskContext(p.label) } : {}),
      segments: p.segments.map((s) => ('code' in s ? { ...s, code: maskContext(s.code) } : { text: maskContext(s.text) })),
    }));
  const parts = mask(spec.parts);
  const short = mask(spec.short);
  const safe = codeIsSafe(parts) && !spec.appOnly;

  const tail = (service: ChatServiceName, whole: boolean): { lines: string[]; buttons: boolean } => {
    if (final) return { lines: [final], buttons: false };
    if (spec.appOnly) return { lines: [spec.appOnly], buttons: false };
    if (!whole) return { lines: [chatText.cardTooLong()], buttons: false };
    const lines = [whoMayText(options)];
    if (!options.buttons) return { lines: [...lines, chatText.answerInApp()], buttons: false };
    if (service === 'mattermost' && !(options.buttons.mattermostUrl && SAFE_URL.test(options.buttons.mattermostUrl)))
      lines.push(chatText.answerWithReactions());
    return { lines, buttons: true };
  };

  // Slack: a header, a section per part (a long part over several), then the buttons.
  const slackFor = (body: Part[], whole: boolean): { out: SlackOut; fits: boolean } => {
    const t = tail('slack', whole);
    const ref = slackLinkRef(link);
    const lines = t.lines.map((l, i) => `${slackEscape(l)}${i === t.lines.length - 1 && ref && !t.buttons ? ` ${ref}` : ''}`);
    const sections = [...body.map(renderSlackPart), lines.join('\n')].flatMap((s) => splitAtParagraphs(s, SLACK_SECTION_MAX));
    const blocks: SlackBlock[] = [
      { type: 'header', text: { type: 'plain_text', text: header } },
      ...sections.map((s) => ({ type: 'section', text: { type: 'mrkdwn', text: s } })),
    ];
    if (t.buttons && options.buttons) blocks.push(slackButtons(options.buttons, spec.confirm));
    const size = sections.reduce((n, s) => n + s.length, 0);
    return {
      out: { service: 'slack', text: fallbackText(`${slackEscape(header)}: ${sections[0] ?? ''}`), blocks },
      fits: blocks.length <= SLACK_BLOCKS_MAX + 2 && size <= CARD_MAX,
    };
  };
  const mattermostFor = (body: Part[], whole: boolean): { out: MattermostOut; fits: boolean } => {
    const t = tail('mattermost', whole);
    const ref = mmLinkRef(link);
    const lines = t.lines.map((l) => mmPlain(l));
    if (ref && !t.buttons) lines[lines.length - 1] += ` ${ref}`;
    const message = [`#### ${mmPlain(header)}`, ...body.map(renderMattermostPart), lines.join('\n')].join('\n\n');
    const attachments = t.buttons && options.buttons ? mattermostButtons(options.buttons) : [];
    return { out: { service: 'mattermost', message, attachments }, fits: message.length <= Math.min(CARD_MAX, MATTERMOST_POST_MAX) };
  };

  let slack = slackFor(parts, safe);
  const slackFits = safe && slack.fits;
  if (!slackFits) slack = slackFor(short, false);
  let mattermost = mattermostFor(parts, safe);
  const mattermostFits = safe && mattermost.fits;
  if (!mattermostFits) mattermost = mattermostFor(short, false);
  const live = !final && Boolean(options.buttons);
  return {
    slack: slack.out,
    mattermost: mattermost.out,
    fits: { slack: slackFits, mattermost: mattermostFits },
    answerable: { slack: live && slackFits, mattermost: live && mattermostFits },
  };
}

/**
 * The card for one change waiting for approval: what, where, risk and why, the whole command, a note
 * when values in it are hidden, the check and what it should show, how it is taken back, the file diff,
 * the approvals so far and needed, and who may approve.
 */
export function changeCard(change: CardChange, options: CardOptions): CardOut {
  const title =
    change.kind === 'setting' ? "A change to sshs3's rules is waiting" : change.kind === 'file' ? 'A file change is waiting for approval' : 'A change is waiting for approval';
  const what: Part = { label: 'What', segments: [{ text: change.description || 'No description was given.' }] };
  const where: Part = { label: 'Where', segments: [{ text: `${change.target || 'Not said.'}${options.production ? ' (production)' : ''}` }] };
  const riskLines: Segment[] = [{ text: [change.riskLevel ? RISK_TEXT[change.riskLevel] : 'Not rated.', change.riskReason].filter(Boolean).join(' ') }];
  if (change.blastRadius) riskLines.push({ text: `What it can affect: ${change.blastRadius}` });
  const risk: Part = { label: 'Risk', segments: riskLines };
  const parts: Part[] = [what, where, risk];
  if (change.command !== undefined) {
    const segments: Segment[] = [{ code: change.command }];
    if (change.hiddenValues) segments.push({ text: chatText.hiddenValues() });
    parts.push({ label: 'Command', segments });
  }
  if (change.diff) parts.push({ label: 'File change', segments: [{ code: change.diff, lang: 'diff' }] });
  if (change.check)
    parts.push({ label: 'Check', segments: [{ code: change.check.command }, { text: `It should show: ${change.check.expected || 'not said'}` }] });
  parts.push({ label: 'Taken back with', segments: change.rollback ? [{ code: change.rollback }] : [{ text: 'No way to take it back was given.' }] });
  // An approved card's last line already says who approved it.
  if (options.final?.state !== 'approved') parts.push({ segments: [{ text: approvalsText(change.requiredApprovals, change.approvals) }] });
  const short: Part[] = [
    { label: 'What', segments: [{ text: shorten(change.description || 'No description was given.', 300) }] },
    where,
    { label: 'Risk', segments: [{ text: change.riskLevel ? RISK_TEXT[change.riskLevel] : 'Not rated.' }] },
  ];
  const sure = change.riskLevel === 'destructive' || options.production;
  return buildCard(
    {
      title,
      parts,
      short,
      ...(change.kind === 'setting' ? { appOnly: chatText.settingInApp() } : {}),
      ...(sure
        ? {
            confirm: {
              title: 'Approve this change?',
              text: options.production ? 'It runs on production.' : 'It can remove or overwrite data.',
            },
          }
        : {}),
    },
    options,
  );
}

const VERDICT: Record<string, string> = {
  approve: 'A second agent read the plan and found no problems.',
  revise: 'A second agent read the plan and asks for changes:',
  unreviewed: 'No second agent could read the plan.',
};

/**
 * The card for a plan waiting for approval: the goal, every step (what, command, target, risk, check),
 * the reviewer's verdict, and how many people must approve.
 */
export function planCard(plan: CardPlan, options: CardOptions): CardOut {
  const parts: Part[] = [{ label: 'Goal', segments: [{ text: plan.goal || 'No goal was given.' }] }];
  plan.steps.forEach((step, i) => {
    const segments: Segment[] = [{ text: step.action || 'No action was given.' }];
    segments.push({ text: `On: ${step.target || 'not said'}. Risk: ${STEP_RISK[step.risk] ?? step.risk}.` });
    if (step.command !== undefined) segments.push({ code: step.command });
    segments.push({ text: `Check: ${step.check || 'not said'}${step.checkExpected ? `. It should show: ${step.checkExpected}` : ''}` });
    if (step.rollback) segments.push({ text: `Taken back with: ${step.rollback}` });
    parts.push({ label: `Step ${i + 1}`, segments });
  });
  const verdict = plan.review?.verdict ?? 'unreviewed';
  const review: Segment[] = [{ text: VERDICT[verdict] ?? VERDICT.unreviewed }];
  if (verdict === 'revise') for (const f of plan.review.findings ?? []) review.push({ text: `• ${f}` });
  parts.push({ label: 'Review', segments: review });
  if (options.final?.state !== 'approved') parts.push({ segments: [{ text: approvalsText(plan.requiredApprovals, plan.approvals) }] });
  const short: Part[] = [
    { label: 'Goal', segments: [{ text: shorten(plan.goal || 'No goal was given.', 300) }] },
    { segments: [{ text: `${plan.steps.length} ${plan.steps.length === 1 ? 'step' : 'steps'}.` }] },
  ];
  return buildCard(
    {
      title: 'A plan is waiting for approval',
      parts,
      short,
      ...(options.production ? { confirm: { title: 'Approve this plan?', text: 'Its steps run on production.' } } : {}),
    },
    options,
  );
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// -------------------------------------------------------------------------------------------------
// Status line
// -------------------------------------------------------------------------------------------------

const STEP_NAMES: Record<string, string> = {
  terminal_exec: 'ran a command',
  terminal_read: 'read a terminal',
  sshs3_cluster_exec: 'ran a command on a cluster',
  sshs3_kb_search: 'searched the knowledge base',
  sshs3_chat_history: 'searched the team chat',
  sshs3_session_search: 'searched earlier conversations',
  sshs3_storage_ops: 'looked at storage',
  sshs3_investigate: 'started an investigation',
  sshs3_plan_propose: 'wrote a plan',
};

function stepText(step: NonNullable<RunView['lastStep']>): string {
  const name = STEP_NAMES[step.name] ?? `used ${step.name.replace(/^(?:sshs3|mcp)_+/, '').replace(/_+/g, ' ')}`;
  return shorten(`${name}${step.target ? ` on ${step.target}` : ''}`, 200);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The one line the status post shows while a run goes on, and when it ends. Masked. */
export function statusText(view: Pick<RunView, 'status' | 'pending' | 'plan' | 'error' | 'lastStep' | 'commandsUsed'>): string {
  const commands = view.commandsUsed ? ` ${plural(view.commandsUsed, 'command', 'commands')} so far.` : '';
  let line: string;
  switch (view.status) {
    case 'queued':
      line = 'Starting.';
      break;
    case 'running':
      line = `Working on it.${commands}${view.lastStep ? ` Last step: ${stepText(view.lastStep)}.` : ''}`;
      break;
    case 'waiting':
      line = view.pending.length
        ? `Waiting for approval of ${view.pending.length === 1 ? 'a change' : `${view.pending.length} changes`}.${commands}`
        : view.plan?.status === 'proposed'
          ? `Waiting for the plan to be approved.${commands}`
          : `Waiting.${commands}`;
      break;
    case 'completed':
      line = `Done.${view.commandsUsed ? ` ${plural(view.commandsUsed, 'command', 'commands')} ran.` : ''}`;
      break;
    case 'failed':
      line = view.error ? `Stopped with an error: ${shorten(view.error.replace(/\s+/g, ' '), 200)}` : 'Stopped with an error.';
      break;
    case 'cancelled':
      line = 'Stopped.';
      break;
    case 'interrupted':
      line = RESTARTED_TEXT;
      break;
    default:
      line = 'Working on it.';
  }
  return maskContext(line);
}

// -------------------------------------------------------------------------------------------------
// Plain messages
// -------------------------------------------------------------------------------------------------

export type ChatLimitKind = 'person-new' | 'person-messages' | 'channel' | 'runs' | 'thread';

const HOW_TO_LINK =
  'In sshs3, open Settings, find Your chat account and make a code. Then send me a direct message: link YOURCODE';

function untilText(at: number | undefined): string {
  if (!at || !Number.isFinite(at)) return '';
  return ` until ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Every short reply the agent bot gives, in plain words. Pass the result to `note`, which masks it and
 * makes it harmless for the chat.
 */
export const chatText = {
  notLinked: (): string => `To answer from chat, link your chat account to sshs3 first. ${HOW_TO_LINK}`,
  notAllowed: (reason?: string): string => `You cannot answer this.${reason ? ` ${reason.trim()}` : ''}`,
  alreadyAnswered: (): string => 'This was already answered.',
  youAnswered: (): string => 'You already answered this.',
  runFailed: (error?: string): string =>
    `Something went wrong and the run stopped${error ? `: ${shorten(error.replace(/\s+/g, ' '), 200)}` : '.'} Reply to try again.`,
  freeze: (where: string, until?: number, why?: string): string =>
    `Nothing is changed on ${where || 'these servers'} now: a change freeze holds${untilText(until)}.${why ? ` Reason: ${why.trim()}` : ''} Nothing was posted to approve.`,
  rateLimited: (kind: ChatLimitKind, limit?: number): string => {
    switch (kind) {
      case 'person-new':
        return `You started ${limit ?? 'too many'} conversations with me in the last hour. Wait a while, then ask again.`;
      case 'person-messages':
        return `You sent me ${limit ?? 'too many'} messages in the last hour. Wait a while, then write again.`;
      case 'channel':
        return `This channel asked me ${limit ?? 'too many'} times in the last hour. Wait a while, then ask again.`;
      case 'runs':
        return 'I am answering other questions right now. Try again in a few minutes.';
      case 'thread':
        return 'I am still working in this thread. Wait for my answer, then write again.';
    }
  },
  budgetSpent: (): string => "I have used this month's budget for answers in chat. An administrator can raise it in sshs3.",
  dmsOff: (): string => 'I do not answer direct messages. Ask me in a channel where I answer, or use sshs3.',
  dmsLinkedOnly: (): string => `I answer direct messages only from people who linked their chat account. ${HOW_TO_LINK}`,
  unlinkedReadOnly: (): string => 'Your chat account is not linked to sshs3, so here I can only look. I change nothing.',
  channelOff: (): string => 'I do not answer in this channel yet. An administrator can turn it on in sshs3.',
  busy: (): string => 'I am still working in this thread. Wait for my answer, then write again.',
  attachmentsNotRead: (): string => 'I cannot read attachments. Paste the text into a message instead.',
  codeInChannel: (): string =>
    'That looked like a link code. A code must not be written where others can read it, so I turned it off. Make a new code in sshs3 and send it to me in a direct message.',
  linkDone: (accountName: string): string =>
    `Linked. You are ${accountName.trim() || 'your account'} in sshs3 now, and you can answer from chat what your account may approve in sshs3.`,
  unlinkDone: (): string => 'Unlinked. You can no longer approve from chat. Link again with a new code from sshs3.',
  unlinkNone: (): string => 'Your chat account was not linked.',
  help: (): string =>
    [
      'I am the sshs3 agent.',
      'In a channel where an administrator turned me on, mention me with your question. I look into it on the servers that channel may reach, and answer in the thread. Mention me again in the thread to go on.',
      'In a direct message, just write.',
      `To approve changes from chat, link your chat account. ${HOW_TO_LINK}`,
      'Words I know in a direct message: link, unlink, help.',
    ].join('\n'),
  hiddenValues: (): string => 'Some values are hidden here because they look like secrets. The command runs with the real values.',
  answerInApp: (): string => 'Answer it in sshs3.',
  answerWithReactions: (): string => 'To answer, react to this message with ✅ to approve or ❌ to deny.',
  cardTooLong: (): string => 'This is too long to show here in full, and nothing is approved from a part of it. Answer it in sshs3.',
  settingInApp: (): string => "Changes to sshs3's own rules are answered only in the app.",
  restInApp: (): string => 'The rest of this answer is in sshs3.',
  restarted: (): string => RESTARTED_TEXT,
  notYours: (): string => 'Only the person who asked can answer this. It runs in their own sshs3 account.',
  notAnswerableHere: (): string => 'This card cannot be answered here. Answer it in sshs3.',
  cardNotPosted: (): string => 'Something is waiting for approval, but its card could not be posted here. Answer it in sshs3.',
  fenceChanged: (): string => 'An administrator changed what I may do in this channel, so I started a new conversation.',
  answeringOff: (): string => 'Answering in chat is off here now. Answer it in sshs3.',
  rulesChanged: (): string => 'An administrator changed what this channel may do, so this cannot be answered here any more. Answer it in sshs3.',
  dataPolicy: (service: string): string =>
    `The data policy in sshs3 does not allow answers in ${service}. Ask in sshs3 instead.`,
};
