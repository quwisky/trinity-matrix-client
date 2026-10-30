import { renderMarkdown, type RenderedMarkdown } from './markdown-render';
import { escapeHtml } from './message-html';

/**
 * Send-side content builders shared by the main timeline and the in-thread composer, so both
 * render markdown and build edit/reply/reaction payloads identically. No SDK types leak to
 * components; only core services call these.
 *
 * The `m.thread` relation is not built here: the SDK adds it when a `threadId` is passed to
 * the send call.
 */

/** A user mentioned in a composed message (drives `m.mentions` + a matrix.to pill). */
export interface Mention {
  userId: string;
  /** The exact text inserted for the mention (e.g. "@Alice"), matched to place the pill. */
  display: string;
}

/**
 * `@room` as a word, matching the boundary of the legacy `.m.rule.roomnotif` (`(?<=^|\W)`
 * and `(?=\W|$)`).
 *
 * Sending `m.mentions` suppresses that legacy rule, so a phrasing this misses (`@room,`,
 * `(@room)`, `**@room**`) loses its room ping entirely. A whitespace-only boundary misses them.
 */
const ROOM_MENTION = /(^|\W)@room(\W|$)/;

/**
 * A deliberate `@room` in text the sender wrote, ignoring quoted `>` lines: quoting someone
 * who wrote `@room` must not re-ping the room.
 */
function mentionsRoom(body: string): boolean {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .some((line) => ROOM_MENTION.test(line));
}

/**
 * The `m.mentions` block, always present even when empty.
 *
 * Its presence makes a homeserver skip the legacy body-matching push rules
 * (`.m.rule.contains_display_name`, `.m.rule.roomnotif`), which would fire on words the sender
 * merely quoted. Synapse's rule JSON still lists those rules as enabled; the exclusion lives
 * in its push evaluator. Mentions are therefore deliberate only (MSC3952).
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
 * Turn each mention's plain `@display` in the sanitized HTML into a matrix.to pill link, once
 * per mention, at its first occurrence in the message's text.
 *
 * Works on the parsed DOM, not the serialized string: a string search could match inside an
 * attribute (`@bob` in an autolinked `https://x.test/@bob`) or inside an earlier pill, and
 * splicing an `<a>` there produces malformed markup. Existing links and code are skipped: a
 * pill inside an anchor is invalid nesting, and `"@Bob"` in a code block is a string literal,
 * not a mention.
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
      // No manual escaping: the serializer writes the attribute, so an id carrying `"` or `<`
      // cannot break out.
      pill.setAttribute('href', `https://matrix.to/#/${mention.userId}`);
      pill.textContent = mention.display;
      rest.replaceWith(pill);
      return;
    }
    node = walker.nextNode();
  }
}

/**
 * Escape text for inline use in `formatted_body`, keeping its line breaks.
 *
 * A raw newline renders as a space under the rendered-HTML container's `white-space: normal`,
 * and replies and `/spoiler` always set `format: org.matrix.custom.html`, so they cannot fall
 * back to the pre-wrap plain-text branch.
 */
function escapeInlineText(text: string): string {
  return escapeHtml(text).replace(/\r\n?|\n/g, '<br>');
}

/**
 * MSC2530 caption fields for a media message. With a caption, `body` is the caption (rich when
 * markdown formats it) and `filename` keeps the real name; without one, `body` is the name.
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
    // An MSC2530 caption replaces the filename as the body, so a push rule matches on it like
    // on a plain message.
    ...mentionsBlock([], mentionsRoom(text)),
  };
}

/**
 * `m.text` content: rich (HTML) when markdown formatted it or the message mentions someone
 * (the pill needs a `formatted_body`), else plain text. Mentions add `m.mentions` and pills.
 */
export function textMessageContent(
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  // `m.mentions` must not depend on the HTML: it has to survive a message whose markup
  // sanitized away or whose parse threw (`renderMarkdown` returns `html: ''` for both), or the
  // message notifies nobody.
  const notified = mentionsBlock(
    mentions.map((m) => m.userId),
    mentionsRoom(text),
  );
  if (md.html !== '' && (md.formatted || mentions.length > 0)) {
    return {
      msgtype: 'm.text',
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: applyMentionPills(md.html, mentions),
      ...notified,
    };
  }
  return { msgtype: 'm.text', body: text, ...notified };
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
 * Exported as data so {@link parseSlashCommand} (names) and the composer's autocomplete
 * (descriptions) cannot disagree.
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

// Escaped because the names are exported: a future `foo.bar` would otherwise act as a
// wildcard in this alternation and widen what the parser accepts.
const SLASH_RE = new RegExp(
  `^/(${SLASH_COMMANDS.map((command) =>
    command.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('|')})(?:[ \\t]+([\\s\\S]*))?$`,
  'i',
);

/**
 * Parse a leading slash command into its name and trimmed argument, or null when the text
 * isn't one (so `/method`, `/etc/passwd` and unknown commands send literally).
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
      msgtype: 'm.emote',
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: applyMentionPills(md.html, mentions),
      ...notified,
    };
  }
  return { msgtype: 'm.emote', body: text, ...notified };
}

/** `m.location` content for a shared point, with the `geo:` URI + MSC3488 fields. */
export function locationMessageContent(
  lat: number,
  lng: number,
  label = 'Shared location',
) {
  const geoUri = `geo:${lat},${lng}`;
  return {
    msgtype: 'm.location',
    body: label,
    geo_uri: geoUri,
    'org.matrix.msc3488.location': { uri: geoUri, description: label },
    'org.matrix.msc3488.asset': { type: 'm.self' },
    'org.matrix.msc1767.text': label,
  };
}

/** `m.text` spoiler content (`/spoiler`) — an `<span data-mx-spoiler>` formatted body. */
function spoilerMessageContent(text: string) {
  return {
    msgtype: 'm.text',
    body: text,
    format: 'org.matrix.custom.html',
    formatted_body: `<span data-mx-spoiler>${escapeInlineText(text)}</span>`,
    // The body is the sender's own text, so it needs the marker like any other.
    ...mentionsBlock([], mentionsRoom(text)),
  };
}

/**
 * Build the message content for a leading slash command, or null when the text isn't a
 * recognized command. Empty-argument `/me`/`/plain`/`/spoiler` also return null, so the raw
 * text isn't swallowed.
 *
 * `renderHtml` is the markdown renderer for the argument; the spec substitutes it to test
 * command parsing without the whole markdown pipeline. Both callers pass `renderMarkdown`.
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
      // `/me` carries @-mentions (pills + `m.mentions`) so `/me waves at @bob` notifies Bob.
      return arg ? emoteMessageContent(arg, renderHtml(arg), mentions) : null;
    // The remaining commands emit a body the sender authored, so they need the same
    // `m.mentions` marker as an ordinary message (else `/plain > @room …` re-pings the room).
    case 'shrug':
      return {
        msgtype: 'm.text',
        body: arg ? `${arg} ${SHRUG}` : SHRUG,
        ...mentionsBlock([], mentionsRoom(arg)),
      };
    case 'plain':
      return arg
        ? {
            msgtype: 'm.text',
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
 * `m.mentions` appears both at the top level and in `m.new_content`: the nested copy is
 * effective, the top-level one stops legacy body rules firing on the `* …` fallback.
 */
export function editMessageContent(
  messageId: string,
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  const rich = md.html !== '' && (md.formatted || mentions.length > 0);
  return {
    msgtype: 'm.text',
    body: `* ${text}`,
    // The top-level body is `* <the whole new text>`, and legacy body-matching rules evaluate
    // it before `.m.rule.suppress_edits`. Without this block, fixing a typo in a quote
    // re-notifies everyone the quote names.
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
      rel_type: 'm.replace',
      event_id: messageId,
    },
  };
}

/**
 * The reply's own words for a rich reply: `formattedBody` is always set, because a reply
 * always carries `format: org.matrix.custom.html`. The quote of the target and its author's
 * mention are added where the target is known.
 */
export function outgoingReplyText(
  text: string,
  md: RenderedMarkdown,
  mentions: Mention[] = [],
) {
  return {
    msgtype: 'text' as const,
    body: text,
    formattedBody: applyMentionPills(
      md.formatted ? md.html : escapeInlineText(text),
      mentions,
    ),
    // The reply's own words, not a quoted fallback, which would re-ping the quote's @room.
    mentions: {
      userIds: mentions.map((m) => m.userId),
      room: mentionsRoom(text),
    },
  };
}

/** `m.annotation` reaction content for `messageId`/`key`. */
export function annotationContent(messageId: string, key: string) {
  return {
    'm.relates_to': {
      rel_type: 'm.annotation',
      event_id: messageId,
      key,
    },
  };
}
