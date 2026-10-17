import DOMPurify from 'dompurify';
import { trimTrailing } from './trim-trailing';
import {
  isMatrixLinkHref,
  matrixToPermalink,
  parseMatrixLink,
  parseMatrixToLink,
} from './matrix-to';

// Tags/attributes permitted in Matrix `org.matrix.custom.html` message bodies
// (the spec allowlist). Anything outside this set is stripped.
const MATRIX_ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'del',
  'div',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'details',
  'summary',
];
// `target` and `rel` stay out of the allowlist, so a sender's own values never survive;
// `markExternalLinks` sets them render-side on http(s) links only.
const MATRIX_ALLOWED_ATTR = [
  'href',
  'alt',
  'title',
  'width',
  'height',
  'src',
  'start',
  'color',
  'class',
  'data-mx-bg-color',
  'data-mx-color',
  'data-mx-emoticon',
  'data-mx-spoiler',
  'data-mx-maths',
];

/**
 * Attributes whose values are not URIs. DOMPurify tests every attribute it doesn't consider
 * URI-safe against ALLOWED_URI_REGEXP, which admits only Matrix's schemes, so without this
 * `color="#ff0000"`, `start="3"` and an image's `width`/`height` would be dropped.
 */
const MATRIX_URI_SAFE_ATTR = ['color', 'start', 'width', 'height'];

/**
 * The attributes Matrix permits on each tag ("Clients should only permit the attributes listed
 * for the tags below", spec v1.19 § m.room.message msgtypes). Keyed by upper-case `nodeName`;
 * a tag missing here keeps no attribute. `font` is deprecated (v1.10) and kept only so older
 * messages still read as their sender meant; `sanitizeOutgoingHtml` never sends it. `input` is
 * the render path's GFM checkbox, read by {@link normaliseTaskItems} and then removed. An
 * image's `width`/`height` reserve its box: {@link normaliseImages} keeps only plain 1–5 digit
 * values, and the feature layer draws an inline image no taller than 300px and no wider than the
 * body (`--trinity-message-image-max-height` on `img.mx-image` in
 * `apps/trinity/src/rendered-markdown.scss`), so a sender's size cannot open a huge empty box.
 */
const MATRIX_TAG_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map<
  string,
  ReadonlySet<string>
>([
  ['A', new Set(['href'])],
  [
    'IMG',
    new Set(['width', 'height', 'alt', 'title', 'src', 'data-mx-emoticon']),
  ],
  ['OL', new Set(['start'])],
  ['CODE', new Set(['class'])],
  [
    'SPAN',
    new Set([
      'data-mx-color',
      'data-mx-bg-color',
      'data-mx-spoiler',
      'data-mx-maths',
    ]),
  ],
  ['DIV', new Set(['data-mx-maths'])],
  ['FONT', new Set(['color', 'data-mx-color', 'data-mx-bg-color'])],
  ['INPUT', new Set(['type', 'checked'])],
]);

const NO_ATTRIBUTES: ReadonlySet<string> = new Set();

// The only image source Matrix permits ("src (provided it is a Matrix Content (mxc://) URI)",
// spec v1.19). Every other scheme is stripped below, so sender HTML can neither smuggle a
// tracking pixel nor embed a `data:` payload; such an image becomes its alt text.
const MXC_SCHEME = /^mxc:\/\//i;

// A sender's `<img src>` must BE an `mxc://` URI, not merely become one. DOMPurify trims every
// attribute value before its attribute hooks see it, so the raw value is checked here, first:
// ` mxc://…` or `\u0001mxc://…` loses its source instead of being trimmed into a valid one.
DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
  if (
    node.nodeName === 'IMG' &&
    !MXC_SCHEME.test(node.getAttribute('src') ?? '')
  ) {
    node.removeAttribute('src');
  }
});

// The only `class` tokens Matrix sanctions: `language-*`, on `code` (syntax highlighting). Every
// class the renderer needs (mx-spoiler, mx-emoticon, colour tokens, …) is added after this
// filter by a render-only pass, so a sender can borrow none of them, nor app/Ionic classes.
const ALLOWED_CLASS = /^language-[\w-]+$/;

// A sender's `formatted_body` can embed `<img src="https://attacker/x.gif">`, which the browser
// would fetch on render, leaking the viewer's IP and acting as a read receipt. The hook above
// strips the `src` of any non-`mxc:` image; this one enforces the per-tag attribute list and
// filters `class` to the Matrix-sanctioned tokens.
//
// Registered once at module load and shared by BOTH {@link sanitizeMatrixHtml} and
// {@link sanitizeOutgoingHtml}, so only security belongs here: attributes set in
// `afterSanitizeAttributes` are not re-filtered against ALLOWED_ATTR and would ride out onto
// the wire. It sits on the default DOMPurify instance, so any other sanitizer in the app must
// create its own (`DOMPurify(window)`), as the maths renderer does, or this per-tag table would
// strip its markup too.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const allowed = MATRIX_TAG_ATTRIBUTES.get(node.nodeName) ?? NO_ATTRIBUTES;
  for (const name of node.getAttributeNames()) {
    if (!allowed.has(name)) node.removeAttribute(name);
  }
  if (node.hasAttribute('class')) {
    const kept = (node.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((token) => ALLOWED_CLASS.test(token));
    if (kept.length > 0) {
      node.setAttribute('class', kept.join(' '));
    } else {
      node.removeAttribute('class');
    }
  }
});

// Pure in its inputs (`html`, `addressesViewer`); FIFO-bounded so a long session can't grow it.
const SANITIZED_HTML_CACHE_MAX = 1000;
const sanitizedHtmlCache = new Map<string, string>();

const MATRIX_PURIFY_CONFIG = {
  ALLOWED_TAGS: MATRIX_ALLOWED_TAGS,
  ALLOWED_ATTR: MATRIX_ALLOWED_ATTR,
  ADD_URI_SAFE_ATTR: MATRIX_URI_SAFE_ATTR,
  // Only safe URL schemes on href/src (DOMPurify also blocks javascript:).
  ALLOWED_URI_REGEXP: /^(?:https?|ftp|mailto|magnet|matrix|mxc):/i,
} as const;

/**
 * The render-side config: the Matrix allowlist plus `input` and the two attributes needed to
 * read a GFM checkbox other clients send. {@link normaliseTaskItems} replaces every input with
 * its glyph and sweeps both attributes off the tree before serialization. **Render only**:
 * `sanitizeOutgoingHtml` keeps {@link MATRIX_PURIFY_CONFIG}, so none of this widens what we send.
 */
const RENDER_PURIFY_CONFIG = {
  ...MATRIX_PURIFY_CONFIG,
  ADD_TAGS: ['input'],
  ADD_ATTR: ['type', 'checked'],
  // `type` needs this and `checked` does not: DOMPurify tests the value of any attribute it
  // doesn't consider URI-safe against ALLOWED_URI_REGEXP, so `type="checkbox"` would be dropped
  // while the valueless `checked` came through, leaving every incoming box unchecked. The
  // attribute is swept off the tree before serialization either way.
  ADD_URI_SAFE_ATTR: [...MATRIX_URI_SAFE_ATTR, 'type'],
  // No `as const`, unlike the config above: it would make these readonly tuples, which don't
  // satisfy DOMPurify's `string[]` config, so the overload stops matching and the `HTMLElement`
  // downcast at the call site fails to compile. Vitest does not typecheck; only `nx build` does.
};

/** Class on each wrapped line of a code block; the numbering gutter hangs off it. */
const CODE_LINE_CLASS = 'code-line';

/**
 * Lines a block must EXCEED before it is marked for numbering: a gutter on a snippet is noise.
 * The line-number setting's automatic mode (default) shows numbers only past this; "Always"
 * ignores it, in CSS, since a preference must not reach the memoized markup.
 */
const LINE_NUMBER_THRESHOLD = 5;

/**
 * Lines beyond which a single block is left unwrapped entirely. Wrapping runs on every block of
 * every message and a sender controls block size up to the event limit, so past this the block
 * renders normally, without numbers, instead of as thousands of synchronous DOM nodes.
 */
const MAX_NUMBERED_LINES = 500;

/**
 * Lines one message may have wrapped in total. The per-block cap is defeated by splitting (125
 * blocks each one line under it is 62,000 spans and a two-megabyte serialization from a single
 * 64 KiB event, which {@link sanitizedHtmlCache} then retains, bounded by entry count rather
 * than bytes), so this bounds their sum.
 */
const MAX_NUMBERED_LINES_PER_MESSAGE = 2_000;

/** `Node.TEXT_NODE`, spelled out because this module never touches a live `Node` global. */
const NODE_TYPE_TEXT = 3;

/** "Tags must not be nested more than 100 levels deep" (spec v1.19). */
const MAX_NESTING_DEPTH = 100;

/**
 * Replace every element nested deeper than {@link MAX_NESTING_DEPTH} with its text. Iterative,
 * so hostile nesting cannot exhaust the stack, and linear: a flattened subtree is turned into
 * one text node and never visited again. Runs on both paths, before any render pass.
 */
function flattenDeepNesting(body: HTMLElement): void {
  const pending: Array<{ readonly element: Element; readonly depth: number }> =
    [{ element: body, depth: 0 }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const depth = next.depth + 1;
    for (const child of [...next.element.children]) {
      if (depth > MAX_NESTING_DEPTH) {
        child.replaceWith(
          child.ownerDocument.createTextNode(child.textContent ?? ''),
        );
      } else {
        pending.push({ element: child, depth });
      }
    }
  }
}

/**
 * `font` and `strike` are read for older messages but never sent (deprecated in spec v1.10):
 * `font` gives way to its content and `strike` becomes `del`, which is what the markdown
 * renderer emits for `~~text~~`.
 */
function replaceDeprecatedTags(root: ParentNode): void {
  // The type argument selects the generic overload; lib.dom marks the `font`/`strike`
  // tag-name overloads deprecated, which `@typescript-eslint/no-deprecated` rejects.
  for (const font of root.querySelectorAll<HTMLElement>('font')) {
    font.replaceWith(...font.childNodes);
  }
  for (const strike of root.querySelectorAll<HTMLElement>('strike')) {
    const del = strike.ownerDocument.createElement('del');
    del.append(...strike.childNodes);
    strike.replaceWith(del);
  }
}

/**
 * Sanitize sender-provided HTML (`formatted_body`) for RENDERING, against the Matrix allowlist.
 * Federated, end-to-end-encrypted content is untrusted and can't be scanned server-side, so it
 * is scrubbed here explicitly rather than relying on Angular's implicit `[innerHTML]`
 * sanitization at the render leaf. Never wrap the result in `bypassSecurityTrust*`.
 *
 * Also applies render-only normalisation (spoilers, syntax highlighting), which is why
 * {@link sanitizeOutgoingHtml} exists separately for the send path. Memoized by input (see
 * {@link sanitizedHtmlCache}).
 */
export function sanitizeMatrixHtml(
  html: string,
  /** Set only when the event's `m.mentions` names the viewer; see {@link markMentionPills}. */
  addressesViewer = false,
): string {
  // Whether the event addresses the viewer is part of the OUTPUT, so it is part of the key:
  // otherwise one event's marking leaks to another with the same body, and survives an account
  // switch.
  const cacheKey = `${addressesViewer ? '1' : '0'}\u0000${html}`;
  const memoized = sanitizedHtmlCache.get(cacheKey);
  if (memoized !== undefined) {
    return memoized;
  }
  // RETURN_DOM hands back the scrubbed <body>, so the passes below run on the tree DOMPurify
  // built: one parse, one serialize.
  // `as const` keeps DOMPurify's typed overload (spread into a plain object it widens to
  // `boolean` and the return falls back to `string`), so dropping RETURN_DOM later is a compile
  // error rather than `innerHTML` being undefined and every body rendering as "undefined".
  const body = DOMPurify.sanitize(html, {
    ...RENDER_PURIFY_CONFIG,
    RETURN_DOM: true as const,
  }) as HTMLElement;
  flattenDeepNesting(body);
  normaliseMatrixUris(body);
  markExternalLinks(body);
  normaliseSpoilers(body);
  normaliseColours(body);
  normaliseMaths(body);
  normaliseImages(body);
  normaliseTaskItems(body);
  markWideLists(body);
  renderCodeBlocks(body);
  markMentionPills(body, addressesViewer);
  const clean = body.innerHTML;
  if (sanitizedHtmlCache.size >= SANITIZED_HTML_CACHE_MAX) {
    const oldest = sanitizedHtmlCache.keys().next().value;
    if (oldest !== undefined) {
      sanitizedHtmlCache.delete(oldest);
    }
  }
  sanitizedHtmlCache.set(cacheKey, clean);
  return clean;
}

/**
 * Angular sanitizes `[innerHTML]` after this sanitizer and does not trust custom URI schemes, so
 * convert valid `matrix:` links to their HTTPS matrix.to form first. Malformed Matrix URIs
 * become a deliberately invalid permalink that the click directive intercepts to explain the
 * error, rather than leaving a dead or externally navigable link.
 */
function normaliseMatrixUris(body: HTMLElement): void {
  for (const anchor of body.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    if (!/^matrix:/i.test(href)) continue;
    const target = parseMatrixLink(href);
    anchor.setAttribute(
      'href',
      target
        ? matrixToPermalink(target)
        : 'https://matrix.to/#/__invalid-matrix-uri__',
    );
  }
}

/** A link that leaves Trinity: only `http(s)`. `mailto:`, `ftp:` and `magnet:` keep their behaviour. */
const EXTERNAL_LINK = /^https?:\/\//i;

/** The spec asks for `noopener`; `noreferrer` also keeps the room's URL out of the destination's logs. */
const EXTERNAL_LINK_REL = 'noopener noreferrer';

/**
 * What the URL parser drops from an href (URL Standard): leading C0 controls and spaces, and
 * ASCII tab, LF and CR anywhere. DOMPurify keeps them, so `\u0001https://…` and
 * `ht\ttps://…` still open `https://…`. Neither pattern can backtrack: the first is anchored
 * and non-global, the second matches one character at a time. Trailing controls don't change
 * the scheme, so they need no pass.
 */
const URL_LEADING_CONTROLS = /^[\u0000- ]+/;
const URL_TAB_OR_NEWLINE = /[\t\n\r]/g;

/**
 * Give every link that leaves Trinity `target="_blank"` and `rel="noopener noreferrer"`, so
 * middle-click, modifier-click, context-menu and drag behave like the plain click
 * `MatrixLinkDirective` intercepts. Runs after {@link normaliseMatrixUris}, so `matrix:` links
 * are already permalinks and stay routed in Trinity.
 *
 * Render-only: `target` is in neither allowlist, so a sender's own `target` never survives and
 * attributes set here never reach the wire.
 */
function markExternalLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = (anchor.getAttribute('href') ?? '')
      .replace(URL_LEADING_CONTROLS, '')
      .replace(URL_TAB_OR_NEWLINE, '');
    if (!EXTERNAL_LINK.test(href)) continue;
    // Write back the href the browser would open so Angular's URL check sees it too: a permalink
    // left with a leading control character is marked `unsafe:` and MatrixLinkDirective can't
    // route it.
    anchor.setAttribute('href', href);
    if (isMatrixLinkHref(href)) continue;
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', EXTERNAL_LINK_REL);
  }
}

/**
 * {@link linkifyText}, with each link that leaves Trinity marked as {@link markExternalLinks}
 * marks it. `linkifyText` emits exactly `<a href="…">` with an escaped URL, so the fixed pattern
 * matches only its own output. Use it for any plain text shown as a message (body, room topic,
 * composer preview) so its links open alike.
 */
export function linkifyMessageText(text: string): string | null {
  return (
    linkifyText(text)?.replace(/<a href="([^"]*)">/g, (anchor, href: string) =>
      EXTERNAL_LINK.test(href) && !isMatrixLinkHref(href)
        ? `<a href="${href}" target="_blank" rel="${EXTERNAL_LINK_REL}">`
        : anchor,
    ) ?? null
  );
}

/** Images one message may show inline; past it the rest read as their alt text. */
const MAX_INLINE_IMAGES = 10;

/** A plain `mxc://server/media-id`, the shape the SDK accepts (as InlineMxcImagesDirective). */
const MXC_IMAGE_SOURCE = /^mxc:\/\/[^/\s]+\/[\w-]+$/;

/** A sender `width`/`height` the leaf may trust to reserve a box: 1–5 digits, nothing else. */
const SENDER_SIZE = /^\d{1,5}$/;

/**
 * Prepare every image for the render leaf. A valid `mxc://` source moves to `data-mx-src`:
 * Angular strips `data-*` at the leaf, so the browser never sees an `mxc:` URL (the CSP would
 * block it), and InlineMxcImagesDirective re-reads it and resolves it through authenticated
 * media. Any other image (no source, `data:`, `blob:`, remote), and every image over the cap,
 * becomes its alt text here, never a fetch; without one it reads "Image".
 *
 * MSC2545 custom emoji (`data-mx-emoticon`) are capped at the leaf (50). Other images are marked
 * `mx-image`, the first {@link MAX_INLINE_IMAGES} only, so a crafted message cannot fire many
 * downloads; outside a link they are buttons that open the viewer, named after their alt text.
 * Their `width`/`height` survive only as plain digits; the leaf caps the drawn size (300px tall).
 */
function normaliseImages(root: ParentNode): void {
  let inline = 0;
  for (const image of root.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    const alt = image.getAttribute('alt');
    const emote = image.hasAttribute('data-mx-emoticon');
    if (
      !MXC_IMAGE_SOURCE.test(source) ||
      (!emote && inline >= MAX_INLINE_IMAGES)
    ) {
      image.replaceWith(
        emote ? (alt ?? 'custom emoji') : alt?.trim() || 'Image',
      );
      continue;
    }
    image.removeAttribute('src');
    image.setAttribute('data-mx-src', source);
    if (emote) {
      image.classList.add('mx-emoticon');
      image.removeAttribute('width');
      image.setAttribute('height', '32');
      continue;
    }
    inline += 1;
    for (const size of ['width', 'height']) {
      if (!SENDER_SIZE.test(image.getAttribute(size) ?? '')) {
        image.removeAttribute(size);
      }
    }
    const name = alt?.trim();
    image.classList.add('mx-image');
    image.setAttribute('alt', name || 'Image');
    if (!image.closest('a[href]')) {
      image.setAttribute('role', 'button');
      image.setAttribute('tabindex', '0');
      image.setAttribute(
        'aria-label',
        name ? `View image: ${name}` : 'View image',
      );
    }
  }
}

/**
 * Mark maths for the render leaf (Matrix spec v1.11 "Mathematical messages"):
 * `span[data-mx-maths]` is inline, `div[data-mx-maths]` display. The sender's fallback content
 * stays until MathsDirective has KaTeX render the LaTeX it re-reads from this string (Angular
 * strips `data-*` at the leaf). Empty maths keeps its fallback.
 *
 * An image in a marked fallback becomes its alt text: KaTeX replaces the fallback, so the inline
 * images {@link normaliseImages} counts and the leaf pairs in document order would fall out of
 * step. Runs before it.
 */
function normaliseMaths(root: ParentNode): void {
  for (const node of root.querySelectorAll(
    'span[data-mx-maths], div[data-mx-maths]',
  )) {
    if ((node.getAttribute('data-mx-maths') ?? '').trim()) {
      node.classList.add('mx-maths');
      for (const image of node.querySelectorAll('img')) {
        image.replaceWith(image.getAttribute('alt')?.trim() || 'Image');
      }
    }
  }
}

/**
 * Tag `matrix.to` user links as mentions, and mark them as addressed to the viewer when the
 * event says so.
 *
 * `.mention` is keyed off the href, so mentions written in other clients render like ours.
 * `.mention--self` is NOT: `formatted_body` is sender-written, so anyone could put
 * `<a href="…/@you">` in a message and get the "addressed to you" treatment without addressing
 * you. It is gated on the event's `m.mentions`, so the strong visual means what a notification
 * means.
 *
 * Render-only, not in the `afterSanitizeAttributes` hook: attributes set there are not
 * re-filtered and would ride out onto the wire. Running after DOMPurify also means any `class`
 * the sender wrote is already gone ({@link ALLOWED_CLASS}).
 */
function markMentionPills(body: HTMLElement, addressesViewer: boolean): void {
  for (const anchor of body.querySelectorAll('a[href]')) {
    const target = parseMatrixToLink(anchor.getAttribute('href') ?? '');
    if (target?.kind !== 'user') {
      continue;
    }
    anchor.classList.add('mention');
    if (addressesViewer) {
      anchor.classList.add('mention--self');
    }
  }
}

/**
 * Sanitize HTML we are about to SEND against the same Matrix allowlist the incoming path uses,
 * so the client never emits a `formatted_body` its own renderer would strip.
 *
 * Applies none of {@link sanitizeMatrixHtml}'s render-only normalisation (spoiler attributes,
 * highlight spans): that is presentation other clients neither expect nor keep. Not memoized:
 * every composed message is distinct, so caching would only evict useful timeline entries.
 */
export function sanitizeOutgoingHtml(html: string): string {
  const body = DOMPurify.sanitize(html, {
    ...MATRIX_PURIFY_CONFIG,
    RETURN_DOM: true as const,
  }) as HTMLElement;
  flattenDeepNesting(body);
  replaceDeprecatedTags(body);
  enforceMxcImages(body);
  return body.innerHTML;
}

/**
 * Reduce every `<img>` we would send whose source is not `mxc:` to its alt text.
 *
 * Matrix accepts no other source, so anything else is an empty box on arrival. The markdown
 * renderer (`image()` in message-content.ts) only sees markdown image tokens and marked passes
 * raw HTML through, so a typed `<img src="data:…">` would ship its whole payload and
 * `<img src="https://…">` a src-less box. This is the one path everything outgoing shares.
 */
function enforceMxcImages(root: ParentNode): void {
  for (const img of root.querySelectorAll('img')) {
    if (!/^mxc:/i.test(img.getAttribute('src') ?? '')) {
      img.replaceWith(img.getAttribute('alt') ?? '');
    }
  }
}

/**
 * Tag spoilers for the renderer. `data-mx-spoiler` marks one in Matrix HTML, but Angular's
 * `[innerHTML]` sanitizer (the re-scrub at the render leaf) drops all `data-*`, so mirror it onto
 * the sanctioned `mx-spoiler` class (class/tabindex/role survive that pass). Focusable with
 * role=button so keyboard users can reveal it too.
 *
 * Render-side only, not in the DOMPurify hook: the hook also runs on the send path, and
 * attributes it sets are not re-filtered against ALLOWED_ATTR, so `tabindex`/`role` (in neither
 * allowlist) would end up in outgoing `formatted_body`.
 *
 * The reason is copied into `label`, which Angular keeps and which is inert on `span`; CSS shows
 * it as generated content on the concealed bar (rendered-markdown.scss), keeping it out of
 * `textContent`, copies and the edit-history diff. `aria-label` names the concealed spoiler for
 * screen readers instead of its hidden text; SpoilerRevealDirective removes it and the role on
 * reveal, and the tab stop once the revealed spoiler does not hold focus.
 */
function normaliseSpoilers(root: ParentNode): void {
  for (const node of root.querySelectorAll('[data-mx-spoiler]')) {
    node.classList.add('mx-spoiler');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    const reason = spoilerReason(node.getAttribute('data-mx-spoiler') ?? '');
    if (reason) {
      node.setAttribute('label', reason);
      node.setAttribute('aria-label', `Spoiler: ${reason}, activate to reveal`);
    } else {
      node.setAttribute('aria-label', 'Spoiler, activate to reveal');
    }
  }
}

/** Longest spoiler reason shown, in characters (code points, so an emoji is one). */
const MAX_SPOILER_REASON = 80;

/**
 * C0 and C1 controls other than the whitespace ones (tab to CR, which collapse to a space
 * instead), and the bidi marks, embeddings, overrides and isolates (ALM/LRM/RLM, U+202A–U+202E,
 * U+2066–U+2069): a reason must not reorder the bar's "Spoiler: " prefix or the message text
 * around it. One character per match, so it cannot backtrack.
 */
const SPOILER_REASON_CONTROLS =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A sender's spoiler reason ("the reason (optionally) being in the `data-mx-spoiler`
 * attribute", spec v1.19) as one short line: controls stripped, trimmed, whitespace
 * collapsed, cut to {@link MAX_SPOILER_REASON}. Linear in the attribute's length.
 */
function spoilerReason(raw: string): string {
  const visible = raw.replace(SPOILER_REASON_CONTROLS, '');
  return Array.from(visible.trim().replace(/\s+/g, ' '))
    .slice(0, MAX_SPOILER_REASON)
    .join('')
    .trimEnd();
}

/** `#` and exactly six hex digits: the only sender colour Trinity applies. */
const SENDER_COLOUR = /^#([0-9a-f]{6})$/i;

/**
 * Turn sender colours into class tokens the render leaf can read: `mx-fg-rrggbb` from
 * `data-mx-color` (or a `font`'s deprecated `color`), `mx-bg-rrggbb` from `data-mx-bg-color`.
 * Angular's `[innerHTML]` sanitizer strips `data-*` and `style` but keeps `class`, and the colour
 * is applied only after the leaf checks its contrast against the current theme
 * (`SenderColoursDirective`), which this memoized, theme-free string cannot know. `color` is
 * removed so no browser paints an unchecked colour.
 *
 * Render-only and after DOMPurify: the hook removed every sender `class` outside `code`
 * ({@link ALLOWED_CLASS}), so a sender cannot write a token directly.
 */
function normaliseColours(root: ParentNode): void {
  for (const node of root.querySelectorAll(
    'span[data-mx-color], span[data-mx-bg-color], font[data-mx-color], font[data-mx-bg-color], font[color]',
  )) {
    // The first valid colour wins, so an invalid `data-mx-color` can't hide a valid `font color`.
    const fg =
      SENDER_COLOUR.exec(node.getAttribute('data-mx-color') ?? '')?.[1] ??
      (node.nodeName === 'FONT'
        ? SENDER_COLOUR.exec(node.getAttribute('color') ?? '')?.[1]
        : undefined);
    const bg = SENDER_COLOUR.exec(
      node.getAttribute('data-mx-bg-color') ?? '',
    )?.[1];
    if (fg) node.classList.add(`mx-fg-${fg.toLowerCase()}`);
    if (bg) node.classList.add(`mx-bg-${bg.toLowerCase()}`);
    node.removeAttribute('color');
  }
}

/** The ballot glyphs a task item opens with, as written by the markdown checkbox renderer. */
const TASK_GLYPH = /^[☑☐]\s/;

/**
 * A GFM checkbox as text, done or not. The single definition of a task item's look: the markdown
 * renderer writes it, {@link normaliseTaskItems} writes it for checkboxes from other clients,
 * and {@link TASK_GLYPH} matches it. The trailing space separates it from the item's text and
 * is what that pattern keys on.
 */
export function taskGlyph(checked: boolean): string {
  return checked ? '☑ ' : '☐ ';
}

/**
 * Turn every GFM checkbox into its glyph, and mark the items that carry one.
 *
 * Our own sends already carry ☑/☐ as text (`checkbox` in message-content.ts); other clients send
 * an `<input>`, which the allowlist drops, so this converts it and both render alike.
 *
 * That is why {@link RENDER_PURIFY_CONFIG} lets `input` (and the two attributes needed to read
 * it) past DOMPurify: every input is replaced or deleted and both attributes are swept off the
 * whole tree before serialization, so neither can reach the output (pinned by tests).
 * `sanitizeOutgoingHtml` keeps the untouched allowlist and still drops the tag.
 *
 * `mx-task` is keyed on the glyph OPENING the item: anywhere else it is a typed character and
 * the item keeps its bullet. Render-side only, like {@link normaliseSpoilers}: in outgoing
 * `formatted_body` it would be markup no other client asked for.
 */
function normaliseTaskItems(root: ParentNode): void {
  for (const box of root.querySelectorAll('input')) {
    const isCheckbox = box.getAttribute('type')?.toLowerCase() === 'checkbox';
    box.replaceWith(
      isCheckbox
        ? box.ownerDocument.createTextNode(
            taskGlyph(box.hasAttribute('checked')),
          )
        : // Anything else was never renderable here; drop it rather than leave a control.
          '',
    );
  }
  // `type`/`checked` are in neither Matrix allowlist. ADD_ATTR is per-call, not per-tag, so
  // they could otherwise ride out on an unrelated element that happened to carry one.
  for (const node of root.querySelectorAll('[type], [checked]')) {
    node.removeAttribute('type');
    node.removeAttribute('checked');
  }
  for (const item of root.querySelectorAll('li')) {
    if (TASK_GLYPH.test(item.textContent ?? '')) {
      item.classList.add('mx-task');
    }
  }
}

/**
 * Mark ordered lists whose numbers are too long for the list's usual indent: `mx-ol-wide` when
 * the longest number has two characters (`10`, `-9`), `mx-ol-long` past that (`100`, or a
 * sender's `start="100000"`), whose numbers the stylesheet puts inside the items. Otherwise they
 * would hang out of the message body, which clips anything beside it. Render-only.
 */
function markWideLists(root: ParentNode): void {
  for (const list of root.querySelectorAll('ol')) {
    const parsed = Number.parseInt(list.getAttribute('start') ?? '', 10);
    const first = Number.isFinite(parsed) ? parsed : 1;
    const items = list.querySelectorAll(':scope > li').length;
    const last = first + Math.max(items - 1, 0);
    const widest = Math.max(String(first).length, String(last).length);
    if (widest > 2) {
      list.classList.add('mx-ol-long');
    } else if (widest === 2) {
      list.classList.add('mx-ol-wide');
    }
  }
}

/** The language a fenced block declares, lowercased, or null when it declares none. */
function fencedLanguage(code: Element): string | null {
  return (
    /(?:^|\s)language-([\w-]+)(?:\s|$)/
      .exec(code.className)?.[1]
      ?.toLowerCase() ?? null
  );
}

/**
 * Prepare every fenced code block for rendering: caption it with the language it declares,
 * and wrap its lines for numbering. Syntax colouring happens at the render leaf, not here (see
 * CodeHighlightDirective in the rooms feature), from DOM nodes after DOMPurify and Angular's own
 * scrub, so nothing it produces can be re-parsed as markup.
 *
 * The caption is an attribute, not an element: `language` is read back by CSS
 * (`pre[language]::after`, see rendered-markdown.scss). Generated content is not part of
 * `textContent`, so an inserted caption node would make a fence-language-only edit read as a
 * text change in the edit-history diff. `data-lang` would be stripped by Angular's `[innerHTML]`
 * sanitizer; `language` is on its allowlist and, unlike `lang`, declares no natural language to
 * screen readers.
 *
 * Captioning runs for every block that declares a language, even without a loaded grammar.
 */
function renderCodeBlocks(root: ParentNode): void {
  // A per-block cap is defeated by splitting, so line wrapping also has a per-message sum.
  let lineBudget = MAX_NUMBERED_LINES_PER_MESSAGE;
  // Iterate `pre`, not `pre > code[class]`: a bare fence yields a `<code>` with no class, which a
  // code-first query would miss. Captioning is gated on the language separately.
  for (const pre of root.querySelectorAll('pre')) {
    for (const code of pre.querySelectorAll(':scope > code')) {
      const lang = fencedLanguage(code);
      if (lang) {
        pre.setAttribute('language', lang);
      }
      const source = code.textContent ?? '';
      lineBudget -= markCodeLines(code, source, lineBudget);
    }
  }
}

/**
 * Wrap each line of a block in `<span class="code-line">` and record how many there are, so
 * CSS can number them.
 *
 * The numbers are generated content keyed off these wrappers, never text (like the language
 * caption): digits in the DOM would be selectable, land in the clipboard, and be read by the
 * edit-history diff. The wrappers add no characters, so `textContent` is byte-identical.
 *
 * The newlines stay OUTSIDE the wrappers, as siblings: under `pre`'s `white-space: pre` they
 * break the lines, so the wrappers stay inline; block-level wrappers would turn every newline
 * into a blank line.
 *
 * The count goes in `rows`, not an invented attribute: Angular's `[innerHTML]` sanitizer runs
 * again at the render leaf against a fixed allowlist that admits `rows` and `language` but would
 * drop `numbered` or `data-lines`. The threshold is applied here, from the content, not in CSS,
 * because `:has()` is below this app's browser floor and a preference must never reach the
 * markup, which is memoized per message and not per viewer.
 */
function markCodeLines(
  code: Element,
  source: string,
  lineBudget: number,
): number {
  if (!source) {
    return 0;
  }
  // A newline inside a child element would put two visual lines in one wrapper, and the
  // numbering would then lie, so only a block with no element children is wrapped.
  if (code.children.length > 0) {
    return 0;
  }
  const lines = source.split('\n');
  // marked and commonmark put a trailing newline inside `<code>`, so nearly every fence ends
  // with one. Counting it would number a phantom blank row and fire the threshold a line early
  // (a five-line block under a setting labelled "over 5 lines").
  const trailingNewline = source.endsWith('\n');
  const count = trailingNewline ? lines.length - 1 : lines.length;
  // Two bounds, because a sender controls both block size and block count. Decline rather than
  // truncate: half a numbered listing is worse than an unnumbered one.
  if (count > MAX_NUMBERED_LINES || count > lineBudget) {
    return 0;
  }

  const doc = code.ownerDocument;
  const wrapped: Node[] = [];
  let current: Node[] = [];
  const flush = (): void => {
    const line = doc.createElement('span');
    line.className = CODE_LINE_CLASS;
    // An empty wrapper on a blank line is deliberate: it still takes a number.
    line.append(...current);
    wrapped.push(line);
    current = [];
  };

  for (const node of [...code.childNodes]) {
    const text =
      node.nodeType === NODE_TYPE_TEXT ? (node.textContent ?? '') : '';
    if (!text.includes('\n')) {
      current.push(node);
      continue;
    }
    text.split('\n').forEach((segment, index) => {
      if (index > 0) {
        flush();
        wrapped.push(doc.createTextNode('\n'));
      }
      if (segment) {
        current.push(doc.createTextNode(segment));
      }
    });
  }
  // Skipped for a trailing newline: its final segment is empty and flushing it would be the
  // phantom row. The `\n` text node is already emitted, so `textContent` is unchanged.
  if (!trailingNewline) {
    flush();
  }

  code.replaceChildren(...wrapped);
  if (count > LINE_NUMBER_THRESHOLD) {
    // On the `code`, not the `pre`: the Matrix allowlist lets a sender put two `<code>` children
    // in one `<pre>`, so writing to the block would be last-writer-wins and the threshold gate
    // would apply to both from whichever wrote last. This also matches where the counter resets.
    code.setAttribute('rows', String(count));
  }
  return count;
}

/**
 * Sentence punctuation that is left outside a URL when it ends the match. `>` can never
 * be captured by the URL pattern's `[^\s<>"']+`; it stays to keep the original set.
 */
const TRAILING_URL_PUNCTUATION = '.,;:!?)]}>';

/** `url` without trailing sentence punctuation, in time linear in the URL length. */
function trimTrailingUrlPunctuation(url: string): string {
  return trimTrailing(url, TRAILING_URL_PUNCTUATION);
}

/**
 * Turn a plain-text body into HTML with clickable links: HTML-escape the text, wrap each
 * http(s) URL in an `<a>`, and keep newlines as `<br>`. Returns `null` when the text has
 * no URL, so a plain message keeps its lighter (pre-wrap) text rendering. Trailing
 * sentence punctuation is left outside the link. Used so a bare URL is clickable even
 * when the sender delivered it as plain text (no formatted_body).
 */
export function linkifyText(text: string): string | null {
  // A local regex — its `lastIndex` advances across the loop and resets per call.
  const re = /https?:\/\/[^\s<>"']+/g;
  let hasLink = false;
  let html = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const whole = match[0];
    const url = trimTrailingUrlPunctuation(whole);
    const trailing = whole.slice(url.length);
    const safeUrl = escapeHtml(url);
    html +=
      escapeHtml(text.slice(lastIndex, match.index)) +
      `<a href="${safeUrl}">${safeUrl}</a>` +
      escapeHtml(trailing);
    lastIndex = match.index + whole.length;
    hasLink = true;
  }
  if (!hasLink) {
    return null;
  }
  return (html + escapeHtml(text.slice(lastIndex))).replace(/\n/g, '<br>');
}

/** The first http(s) URL in `text` (trailing sentence punctuation trimmed), or null. */
export function firstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/.exec(text);
  if (!match) {
    return null;
  }
  return trimTrailingUrlPunctuation(match[0]);
}

/** Escape text for safe interpolation into the `<mx-reply>` HTML fallback. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
