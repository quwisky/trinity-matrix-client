import {
  EventType,
  MsgType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { Marked, Renderer, type Tokens } from 'marked';
import {
  escapeHtml,
  sanitizeOutgoingHtml,
  stripReplyFallbackText,
  taskGlyph,
} from './message-view';

/**
 * Send-side content builders shared by the main timeline ({@link TimelineService})
 * and the in-thread composer ({@link ThreadsService}) so both render markdown and
 * build edit/reply/reaction payloads identically — the outbound counterpart to
 * `message-view.ts` (which projects events *into* render models). No SDK types leak
 * to components; only core services call these.
 *
 * The `m.thread` relation itself is NOT built here: the SDK adds it (with the right
 * `is_falling_back` and `m.in_reply_to`) when a `threadId` is passed to the send
 * call, so a thread send reuses the exact same content shape as the main timeline.
 */

/** Result of rendering composer markdown to sanitized HTML. */
export interface RenderedMarkdown {
  /** True when the markdown actually added formatting (else send/store as plain text). */
  formatted: boolean;
  /** Sanitized HTML for `formatted_body`. */
  html: string;
}

/** A user mentioned in a composed message (drives `m.mentions` + a matrix.to pill). */
export interface Mention {
  userId: string;
  /** The exact text inserted for the mention (e.g. "@Alice"), matched to place the pill. */
  display: string;
}

/**
 * `@room` as a WORD, matching the boundary the legacy `.m.rule.roomnotif` used: matrix-js-sdk
 * and Synapse wrap a body pattern in `(?<=^|\W)`/`(?=\W|$)`.
 *
 * A whitespace-only boundary is the obvious thing to write and is wrong, because sending
 * `m.mentions` SUPPRESSES the legacy rule — so any phrasing this fails to recognise loses its
 * room ping entirely rather than falling back to the old behaviour. `@room,` `@room!`
 * `(@room)` and `**@room**` are all ordinary ways to write it and all miss a `\s` boundary.
 */
const ROOM_MENTION = /(^|\W)@room(\W|$)/;

/**
 * A deliberate `@room` in text the sender actually wrote — ignoring quoted lines.
 *
 * Quoting someone who wrote `@room` must not re-ping the room, which is the whole reason
 * `m.mentions` is now always sent (see {@link mentionsBlock}). Lines beginning with `>` are
 * somebody else's words being carried along, so they are not the quoter's intent.
 */
export function mentionsRoom(body: string): boolean {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .some((line) => ROOM_MENTION.test(line));
}

/**
 * The `m.mentions` block — ALWAYS present, even when it is empty.
 *
 * Its presence is what makes a homeserver skip the legacy body-matching push rules
 * (`.m.rule.contains_display_name`, `.m.rule.roomnotif`), which match on the plain-text
 * `body` and therefore fire on words the sender merely QUOTED. Verified against Synapse
 * 1.119: an identical quoted body highlights the named user without this key and is silent
 * with it. Note the server's own rule JSON still lists those rules as enabled with their
 * original conditions — the exclusion lives in its push evaluator, so reading the rules
 * suggests the opposite of what actually happens.
 *
 * The trade is that mentioning someone now has to be deliberate: typing a display name in
 * passing no longer notifies them, and `@room` only counts when the sender wrote it
 * themselves. That is the intended shape of intentional mentions (MSC3952), and it is the
 * only way to stop a quote from notifying people who were never addressed.
 */
function mentionsBlock(
  userIds: string[],
  room = false,
): Record<string, unknown> {
  const ids = [...new Set(userIds)].filter(Boolean);
  return {
    'm.mentions': {
      ...(ids.length > 0 ? { user_ids: ids } : {}),
      ...(room ? { room: true } : {}),
    },
  };
}

/**
 * Turn each mention's plain `@display` in the already-sanitized HTML into a matrix.to pill
 * link — once per mention, at its first occurrence in the message's *text*.
 *
 * Done over the parsed DOM rather than by searching the serialized string. A string search
 * has no idea what is text and what is markup, so a display name could match inside an
 * attribute — `@bob` inside an autolinked `https://x.test/@bob` href, or inside a pill this
 * function had just inserted — and splicing an `<a>` in there produces malformed markup on
 * the wire. Walking text nodes makes that unrepresentable, and sidesteps having to predict
 * how the serializer escapes a display name (DOMPurify leaves `'` and `"` raw in text, which
 * an `escapeHtml`-based needle silently failed to match).
 *
 * Code and existing links are skipped. A pill inside an anchor is invalid nesting, and a
 * display name that happens to appear in link text should stay link text — but the sharper
 * case is code: `const a = "@Bob"` in a fenced block is a string literal, not a mention, and
 * splicing an anchor into it corrupts the listing on the wire and costs the real mention
 * later in the message its pill.
 */
function applyMentionPills(html: string, mentions: Mention[]): string {
  if (mentions.length === 0) {
    return html;
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const mention of mentions) {
    placeMentionPill(doc, mention);
  }
  return doc.body.innerHTML;
}

/** Replace the first text occurrence of `mention.display` with a matrix.to link. */
function placeMentionPill(doc: Document, mention: Mention): void {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const at = (node.nodeValue ?? '').indexOf(mention.display);
    if (at !== -1 && !node.parentElement?.closest('a, code, pre')) {
      const target = node as Text;
      const rest = target.splitText(at);
      rest.splitText(mention.display.length);
      const pill = doc.createElement('a');
      // No manual escaping: setting the attribute and letting the serializer write it is
      // what makes an id carrying `"` or `<` unable to break out.
      pill.setAttribute('href', `https://matrix.to/#/${mention.userId}`);
      pill.textContent = mention.display;
      rest.replaceWith(pill);
      return;
    }
    node = walker.nextNode();
  }
}

/**
 * GFM task-list markers as text.
 *
 * marked renders `- [x] done` as `<input checked disabled type="checkbox">`, and `input`
 * is in neither the Matrix allowlist nor Angular's — so the checkbox was silently deleted
 * on the way out and the list arrived as bare items, losing the done/not-done state
 * entirely. A ballot-box glyph carries that state through every client, screen reader and
 * plain-text fallback without widening the allowlist.
 *
 * Deliberately not an `<input>`: making one interactive would mean editing and re-sending
 * the source event on each click, which is a feature rather than a render concern.
 */
function checkbox({ checked }: Tokens.Checkbox): string {
  return taskGlyph(checked);
}

/**
 * A markdown image whose source the Matrix allowlist will not carry, rendered as a link.
 *
 * Matrix requires an `mxc:` source, so `![pic](https://x/y.png)` sanitizes down to a
 * src-less `<img>` — an empty box, with the URL nowhere to be seen, because every client
 * prefers `formatted_body` over the `body` that still holds it. A link keeps the address
 * usable and says what it was for.
 *
 * **`mxc:` only.** `ALLOWED_URI_REGEXP` lists no other scheme an `<img>` could survive with,
 * and Matrix accepts no other: anything else loses its `src` and becomes the empty box this
 * exists to avoid. `blob:` is the obvious case. `data:` is the deceptive one — DOMPurify has a
 * built-in `DATA_URI_TAGS` exception that lets it through `<img>` regardless of our regexp, so
 * it *looked* carried while being just as unrenderable on arrival, after putting the whole
 * base64 payload on the wire. (The render path does allow `blob:`/`data:` on an INCOMING
 * `<img>`; the send path does not, and this follows the send path because that is where it
 * runs.)
 */
function image({ href, title, text }: Tokens.Image): string {
  if (/^mxc:/i.test(href)) {
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
  }
  // A data: URI is its own payload, so it can be neither shown nor usefully linked — and it
  // must not stand in as the link text either, or the blob goes out as the caption instead.
  if (/^data:/i.test(href)) {
    return escapeHtml(text || 'image');
  }
  return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
}

/**
 * A link, with any anchor {@link image} produced inside it unwrapped.
 *
 * `[![badge](https://img/b.svg)](https://target)` — a badge linking somewhere, the common
 * shape for this — makes the image renderer above emit an `<a>` *inside* the link's own
 * `<a>`. Nested anchors are not representable in HTML: the parser's adoption-agency step
 * splits them, so `sanitizeOutgoingHtml` returned an empty `<a>` followed by a link to the
 * IMAGE, and the target the user actually linked to was gone. Keeping the inner text and
 * dropping the inner wrapper leaves the one link that was meant.
 *
 * Delegates to marked's own renderer for everything else, so URL cleaning (and its
 * bare-text fallback for a URL that will not encode) stays exactly as marked defines it —
 * only the nesting is repaired.
 */
function link(this: Renderer, token: Tokens.Link): string {
  const rendered = Renderer.prototype.link.call(this, token);
  const match = /^(<a\b[^>]*>)([\s\S]*)(<\/a>)$/.exec(rendered);
  if (!match) {
    return rendered;
  }
  const [, open, inner, close] = match;
  return open + inner.replace(/<\/?a\b[^>]*>/g, '') + close;
}

/**
 * Escape text for embedding inline in `formatted_body`, keeping its line breaks.
 *
 * `escapeHtml` alone leaves a raw newline, which renders as a space under the rendered-HTML
 * container's `white-space: normal` — so a reply or a `/spoiler` written across two lines
 * arrived as one. Those paths always set `format: org.matrix.custom.html`, so unlike a plain
 * message they cannot fall back to the pre-wrap plain-text branch.
 */
function escapeInlineText(text: string): string {
  return escapeHtml(text).replace(/\r\n?|\n/g, '<br>');
}

/**
 * The composer's markdown engine.
 *
 * A module-local instance, NOT the global `marked` singleton: `marked.use()` and
 * `marked.setOptions()` mutate process-wide state, so any transitive dependency calling
 * either could silently change the HTML we put on the wire. Every option marked exposes is
 * set explicitly — its defaults are not a contract we control.
 */
const markdown = new Marked({
  // Tables, ~~strikethrough~~, task lists, autolinks — and a prerequisite for `breaks`.
  gfm: true,
  // A single newline is a line break. Chat convention (Enter sends, Shift+Enter inserts a
  // newline), and it is what makes the plain and formatted render paths agree: the plain
  // branch renders under `white-space: pre-wrap` and `linkifyText` already emits <br>,
  // while markdown used to emit a bare \n that `white-space: normal` collapsed away.
  breaks: true,
  // Never emulate markdown.pl's original bugs.
  pedantic: false,
  // Surface a parse failure as a throw. With `silent: true` marked returns
  // "<p>An error occurred:</p><pre>…</pre>" — which we would then SEND as the message.
  silent: false,
  // parse() returns a string, never a Promise: the whole send path is synchronous.
  async: false,
  renderer: { checkbox, image, link },
});

/**
 * Render composer markdown to sanitized HTML. `formatted` is false when the HTML
 * carries no formatting beyond the plain text, so the caller can send plain text.
 */
export function renderMarkdown(text: string): RenderedMarkdown {
  let rendered: string;
  try {
    rendered = markdown.parse(text, { async: false });
  } catch {
    return { formatted: false, html: '' };
  }
  const html = sanitizeOutgoingHtml(rendered);
  // Input whose every construct the allowlist strips (an HTML comment, a lone <script>)
  // sanitizes to nothing; sending an empty formatted_body is worse than sending plain text.
  // The callers check `html` as well as `formatted`, because a message with a mention
  // takes the rich branch regardless and would otherwise send an empty formatted_body —
  // which every client, Element included, prefers over `body`, rendering a blank message.
  if (html.trim() === '') {
    return { formatted: false, html: '' };
  }
  return {
    formatted:
      normaliseForCompare(htmlToText(html)) !== normaliseForCompare(text),
    html,
  };
}

/**
 * MSC2530 caption fields for a media message. With a caption, `body` carries the
 * caption text (rich when markdown formats it) and `filename` preserves the real
 * file name; without one, `body` is the file name (the pre-caption behaviour).
 */
export function mediaCaptionFields(
  filename: string,
  caption: string,
): Record<string, unknown> {
  const text = caption.trim();
  if (!text) {
    return { body: filename };
  }
  const md = renderMarkdown(text);
  return {
    body: text,
    filename,
    ...(md.formatted
      ? { format: 'org.matrix.custom.html', formatted_body: md.html }
      : {}),
    // An MSC2530 caption REPLACES the filename as the body, so it is user-authored text a
    // push rule will match on — the same exposure as a plain message.
    ...mentionsBlock([], mentionsRoom(text)),
  };
}

/**
 * `m.text` content: rich (HTML) when markdown formatted it OR the message mentions
 * someone (mentions need a `formatted_body` for the pill), else plain text. Any
 * mentions add `m.mentions` (so modern homeservers notify) and matrix.to pills.
 */
export function textMessageContent(
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  // `m.mentions` does not depend on the HTML: it is what makes a modern homeserver notify
  // the people named, and it has to outlive a message whose markup sanitized away to nothing
  // (or whose parse threw — `renderMarkdown` returns `html: ''` for both). Dropping it with
  // the empty `formatted_body` sent the message and quietly notified nobody.
  const notified = mentionsBlock(
    mentions.map((m) => m.userId),
    mentionsRoom(text),
  );
  if (md.html !== '' && (md.formatted || mentions.length > 0)) {
    return {
      msgtype: MsgType.Text,
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: applyMentionPills(md.html, mentions),
      ...notified,
    };
  }
  return { msgtype: MsgType.Text, body: text, ...notified };
}

/** The classic shrug the `/shrug` command appends. */
const SHRUG = '¯\\_(ツ)_/¯';

/** One IRC-style command the composer recognises, and what to tell someone about it. */
export interface SlashCommand {
  /** The word after the slash, lower case. */
  readonly name: string;
  /** What it does, in the words a menu would use. */
  readonly description: string;
  /** What follows it, if anything — shown after the name so the shape is visible. */
  readonly argument?: string;
}

/**
 * The IRC-style commands the composer recognises, with the descriptions any UI should use.
 *
 * Exported as data rather than as a bare list of names because the two consumers need
 * different things from it and must not disagree: {@link parseSlashCommand} needs the names,
 * and the composer's autocomplete needs to say what each one does. Redeclaring the
 * descriptions in the feature would let a command be renamed here and go on being offered
 * under its old name there.
 */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'me',
    description: 'Send as an action, in the third person',
    argument: '<message>',
  },
  { name: 'shrug', description: 'Append ¯\\_(ツ)_/¯', argument: '[message]' },
  {
    name: 'plain',
    description: 'Send without formatting, markdown and all',
    argument: '<message>',
  },
  {
    name: 'spoiler',
    description: 'Hide the message until it is clicked',
    argument: '<message>',
  },
];

const SLASH_RE = new RegExp(
  `^/(${SLASH_COMMANDS.map((command) => command.name).join('|')})(?:[ \\t]+([\\s\\S]*))?$`,
  'i',
);

/**
 * Parse a leading IRC-style slash command (`/me`, `/shrug`, `/plain`, `/spoiler`) into its
 * name + trimmed argument, or null when the text isn't one of them (so it sends literally —
 * `/method`, `/etc/passwd`, and unknown commands are all left as plain text).
 */
export function parseSlashCommand(
  text: string,
): { command: string; arg: string } | null {
  const match = SLASH_RE.exec(text);
  return match
    ? { command: match[1].toLowerCase(), arg: (match[2] ?? '').trim() }
    : null;
}

/** `m.emote` content (`/me`), rich when the markdown adds formatting. */
export function emoteMessageContent(
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  // As in `textMessageContent`: the notification outlives the markup.
  const notified = mentionsBlock(
    mentions.map((m) => m.userId),
    mentionsRoom(text),
  );
  if (md.html !== '' && (md.formatted || mentions.length > 0)) {
    return {
      msgtype: MsgType.Emote,
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: applyMentionPills(md.html, mentions),
      ...notified,
    };
  }
  return { msgtype: MsgType.Emote, body: text, ...notified };
}

/** `m.location` content for a shared point, with the `geo:` URI + MSC3488 fields. */
export function locationMessageContent(
  lat: number,
  lng: number,
  label = 'Shared location',
) {
  const geoUri = `geo:${lat},${lng}`;
  return {
    msgtype: MsgType.Location,
    body: label,
    geo_uri: geoUri,
    'org.matrix.msc3488.location': { uri: geoUri, description: label },
    'org.matrix.msc3488.asset': { type: 'm.self' },
    'org.matrix.msc1767.text': label,
  };
}

/** `m.text` spoiler content (`/spoiler`) — an `<span data-mx-spoiler>` formatted body. */
export function spoilerMessageContent(text: string) {
  return {
    msgtype: MsgType.Text,
    body: text,
    format: 'org.matrix.custom.html',
    formatted_body: `<span data-mx-spoiler>${escapeInlineText(text)}</span>`,
    // A spoiler's body is the sender's own text, so it needs the marker like any other.
    ...mentionsBlock([], mentionsRoom(text)),
  };
}

/**
 * Build the message content for a leading slash command, or null when the text isn't a
 * recognized command (send it as a normal message). Empty-argument `/me`/`/plain`/`/spoiler`
 * also return null — nothing to send — so the raw text isn't swallowed.
 *
 * `renderHtml` renders the argument's markdown. It was a parameter because
 * {@link renderMarkdown} needed a `DomSanitizer` injected; that is no longer true, and it
 * survives only as the seam the spec substitutes to test command parsing without exercising
 * the whole markdown pipeline. Both callers pass `renderMarkdown` itself.
 */
export function slashCommandContent(
  text: string,
  renderHtml: (markdown: string) => RenderedMarkdown,
  mentions: Mention[] = [],
): Record<string, unknown> | null {
  const parsed = parseSlashCommand(text);
  if (!parsed) {
    return null;
  }
  const { command, arg } = parsed;
  switch (command) {
    case 'me':
      // `/me` is the emote path, so carry any @-mentions (pills + `m.mentions`)
      // through — otherwise a `/me waves at @bob` wouldn't notify Bob.
      return arg ? emoteMessageContent(arg, renderHtml(arg), mentions) : null;
    // The remaining commands emit a body the sender authored, so they need the same
    // `m.mentions` marker as an ordinary message — otherwise `/plain > @room …` is a hole
    // straight through the fix.
    case 'shrug':
      return {
        msgtype: MsgType.Text,
        body: arg ? `${arg} ${SHRUG}` : SHRUG,
        ...mentionsBlock([], mentionsRoom(arg)),
      };
    case 'plain':
      return arg
        ? {
            msgtype: MsgType.Text,
            body: arg,
            ...mentionsBlock([], mentionsRoom(arg)),
          }
        : null;
    case 'spoiler':
      return arg ? spoilerMessageContent(arg) : null;
    default:
      return null;
  }
}

/**
 * `m.replace` edit content targeting `messageId`, with the leading `* ` fallback.
 *
 * `m.mentions` appears BOTH at the top level and in `m.new_content`. The nested copy is the
 * effective content; the top-level one is what stops the legacy body rules firing on the
 * `* …` fallback, which they do before `.m.rule.suppress_edits` is reached.
 */
export function editMessageContent(
  messageId: string,
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  const rich = md.html !== '' && (md.formatted || mentions.length > 0);
  return {
    msgtype: MsgType.Text,
    body: `* ${text}`,
    // The TOP-LEVEL body is `* <the whole new text>`, and the legacy body-matching rules are
    // evaluated against it before `.m.rule.suppress_edits` is ever reached — measured on
    // Synapse 1.119, where an edit whose body quoted a display name highlighted the reader
    // until this block was added. Without it, correcting one typo in a quote re-notifies
    // everyone the quote names.
    ...mentionsBlock(
      mentions.map((m) => m.userId),
      mentionsRoom(text),
    ),
    ...(rich
      ? {
          format: 'org.matrix.custom.html',
          formatted_body: `* ${applyMentionPills(md.html, mentions)}`,
        }
      : {}),
    'm.new_content': textMessageContent(text, md, mentions),
    'm.relates_to': {
      rel_type: RelationType.Replace,
      event_id: messageId,
    },
  };
}

/**
 * Rich-reply content (`m.in_reply_to`): a plain `> …` quote in `body` and an
 * `<mx-reply>` block in `formatted_body`, so every client renders (and strips) it
 * correctly. When sent with a `threadId`, the SDK layers the `m.thread` relation on
 * top with `is_falling_back: false`, keeping this as a real in-thread reply.
 */
export function replyMessageContent(
  room: Room,
  messageId: string,
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  const target = room.findEventById(messageId);
  const sender = target?.getSender() ?? '';
  const origBody = stripReplyFallbackText(
    (target?.getContent()['body'] as string) ?? '',
  );
  const firstLine = origBody.split('\n')[0] ?? '';
  const replyHtml = applyMentionPills(
    md.formatted ? md.html : escapeInlineText(text),
    mentions,
  );
  // Escape the ids interpolated into the href attributes — a hostile sender/room id
  // must not break out of the attribute and inject markup into the reply we emit.
  const roomLink = `https://matrix.to/#/${escapeHtml(room.roomId)}/${escapeHtml(messageId)}`;
  const userLink = `https://matrix.to/#/${escapeHtml(sender)}`;
  const mxReply =
    `<mx-reply><blockquote>` +
    `<a href="${roomLink}">In reply to</a> ` +
    `<a href="${userLink}">${escapeHtml(sender)}</a><br>` +
    `${escapeHtml(firstLine)}</blockquote></mx-reply>`;
  return {
    msgtype: MsgType.Text,
    body: `> <${sender}> ${firstLine}\n\n${text}`,
    format: 'org.matrix.custom.html',
    formatted_body: `${mxReply}${replyHtml}`,
    'm.relates_to': { 'm.in_reply_to': { event_id: messageId } },
    // A reply pings the message's author, plus anyone @-mentioned in the reply. `text` is
    // the reply's own words — deliberately NOT the `body` above, whose `> <sender> …`
    // fallback quotes the message being answered and would re-ping its @room.
    ...mentionsBlock(
      [sender, ...mentions.map((m) => m.userId)],
      mentionsRoom(text),
    ),
  };
}

/** `m.annotation` reaction content for `messageId`/`key`. */
export function annotationContent(messageId: string, key: string) {
  return {
    'm.relates_to': {
      rel_type: RelationType.Annotation,
      event_id: messageId,
      key,
    },
  };
}

/** The id of the current user's own reaction event for a key on a message, if any. */
export function myReactionId(
  client: MatrixClient,
  room: Room,
  messageId: string,
  key: string,
): string | null {
  const annotations = room.relations
    .getChildEventsForEvent(
      messageId,
      RelationType.Annotation,
      EventType.Reaction,
    )
    ?.getSortedAnnotationsByKey();
  const match = annotations?.find(([k]) => k === key);
  if (!match) {
    return null;
  }
  const myId = client.getUserId();
  const mine = [...match[1]].find(
    (e) => !e.isRedacted() && e.getSender() === myId,
  );
  return mine?.getId() ?? null;
}

/**
 * Short, single-line preview of a message event's text — feeds both the main
 * timeline's thread indicator and the room list's muted last-message line.
 * Handles undecryptable and redacted events, strips any rich-reply fallback quote,
 * collapses whitespace, and returns '…' when nothing renders.
 */
export function messagePreview(event: MatrixEvent): string {
  if (event.isDecryptionFailure()) {
    return '⚠️ Unable to decrypt';
  }
  if (event.isRedacted()) {
    return '(message deleted)';
  }
  const content = event.getContent();
  const body = stripReplyFallbackText((content['body'] as string) ?? '');
  return body.replace(/\s+/g, ' ').trim() || '…';
}

/**
 * Plain-text content of an HTML string, with `<br>` restored as a newline (to detect
 * whether markdown added formatting).
 *
 * Restoring `<br>` is load-bearing: `textContent` drops it entirely, so under
 * `breaks: true` every multi-line plain message would compare as though markdown had
 * rewritten it ("line one\nline two" against "line oneline two") and be sent as HTML.
 */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const br of doc.body.querySelectorAll('br')) {
    br.replaceWith(doc.createTextNode('\n'));
  }
  return doc.body.textContent ?? '';
}

/**
 * The form both sides of the "did markdown add anything?" comparison are reduced to.
 *
 * The question is whether the rendered HTML says something the plain text doesn't — not
 * whether it reproduces it byte for byte — so purely cosmetic whitespace is levelled out
 * first: CRLF so a pasted Windows line ending isn't read as formatting; trailing spaces
 * so markdown's two-space hard break (redundant now `breaks` is on) doesn't count; runs
 * of blank lines so a paragraph break stays a plain-text message. `body` always carries
 * the author's exact text, so nothing is lost by comparing loosely here.
 */
function normaliseForCompare(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
