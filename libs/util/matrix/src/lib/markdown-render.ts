import { Marked, Renderer, type Tokens } from 'marked';
import { escapeHtml, sanitizeOutgoingHtml, taskGlyph } from './message-html';
import { trimTrailing } from './trim-trailing';

/** Result of rendering composer markdown to sanitized HTML. */
export interface RenderedMarkdown {
  /** True when the markdown actually added formatting (else send/store as plain text). */
  formatted: boolean;
  /** Sanitized HTML for `formatted_body`. */
  html: string;
}

/**
 * GFM task-list markers as text.
 *
 * marked renders `- [x] done` as an `<input type="checkbox">`, which neither the Matrix
 * allowlist nor Angular's carries, so the done state would be lost. A ballot-box glyph keeps it
 * through every client and plain-text fallback. Not an interactive `<input>`: that would mean
 * editing and re-sending the source event on each click.
 */
function checkbox({ checked }: Tokens.Checkbox): string {
  return taskGlyph(checked);
}

/**
 * A markdown image whose source the Matrix allowlist will not carry, rendered as a link.
 *
 * Matrix requires an `mxc:` source, so `![pic](https://x/y.png)` would sanitize to a src-less
 * `<img>`, an empty box, while clients prefer `formatted_body` over the `body` holding the URL.
 *
 * Only `mxc:` stays an `<img>`: `ALLOWED_URI_REGEXP` lists no other scheme, and Matrix accepts
 * none. `data:` only looks carried: DOMPurify's built-in `DATA_URI_TAGS` exception lets it
 * through `<img>` regardless of our regexp, yet it is unrenderable on arrival and puts the
 * whole base64 payload on the wire. The render path allows `blob:`/`data:` on an incoming
 * `<img>`; the send path does not, and this follows the send path.
 */
function image({ href, title, text }: Tokens.Image): string {
  if (/^mxc:/i.test(href)) {
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
  }
  // A data: URI is its own payload: neither showable nor linkable, and it must not become the
  // link text either, or the blob goes out as the caption.
  if (/^data:/i.test(href)) {
    return escapeHtml(text || 'image');
  }
  return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
}

/**
 * A link, with any anchor {@link image} produced inside it unwrapped.
 *
 * `[![badge](https://img/b.svg)](https://target)` makes the image renderer emit an `<a>`
 * inside the link's `<a>`. Nested anchors are not representable in HTML: the parser splits
 * them, and the user's real target is lost. Everything else is marked's own renderer, so URL
 * cleaning stays as marked defines it.
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
 * The composer's markdown engine.
 *
 * A module-local instance, not the global `marked` singleton: `marked.use()` and
 * `marked.setOptions()` mutate process-wide state, so a transitive dependency could change the
 * HTML we send. Every option is set explicitly because marked's defaults are not our contract.
 */
const markdown = new Marked({
  // Tables, strikethrough, task lists, autolinks; a prerequisite for `breaks`.
  gfm: true,
  // A single newline is a line break, so the plain branch (`white-space: pre-wrap`, with
  // `linkifyText` emitting <br>) and the formatted branch render alike.
  breaks: true,
  pedantic: false,
  // Surface a parse failure as a throw: `silent: true` returns "<p>An error occurred:</p>..."
  // markup, which would then be sent as the message.
  silent: false,
  // parse() must return a string: the whole send path is synchronous.
  async: false,
  renderer: { checkbox, image, link },
});

/** A run of at least this many spaces between two other characters is shielded. */
const SHIELDED_RUN = 32;
/** Private-use characters that stand in for a shielded run: open, close, and ten digits. */
const SHIELD_OPEN = '\uE000';
const SHIELD_CLOSE = '\uE001';
const SHIELD_DIGIT_ZERO = 0xe010;
const SHIELD_CHARS = /[\uE000-\uE01F]/;
const SHIELD_MARK = /\uE000([\uE010-\uE019]+)\uE001/g;

/**
 * Stand in for long runs of spaces between two words before marked sees them.
 *
 * marked's inline text rule looks ahead for "two or more spaces, then a newline" at every
 * position, so a run of n spaces costs O(n^2) on every composer-preview keystroke. The run
 * becomes a space, a private-use mark naming it, and a space, and is restored verbatim in the
 * HTML; the two real spaces keep neighbour-sensitive rules (emphasis flanking, autolinks)
 * working. Runs at line start (indentation, code blocks) or before a newline (hard break), and
 * text already holding a shield character, are left to marked. A scan, not a regex:
 * ` {32,}(?=\S)` is itself quadratic on a run that ends in a newline.
 */
function shieldSpaceRuns(
  text: string,
): { text: string; runs: number[] } | null {
  if (SHIELD_CHARS.test(text)) {
    return null;
  }
  const runs: number[] = [];
  let out = '';
  let copied = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 0x20) continue;
    let end = i;
    while (end < text.length && text.charCodeAt(end) === 0x20) end++;
    const before = i > 0 ? text[i - 1] : '\n';
    const after = end < text.length ? text[end] : '\n';
    if (
      end - i >= SHIELDED_RUN &&
      before !== '\n' &&
      before !== '\r' &&
      after !== '\n' &&
      after !== '\r'
    ) {
      out += `${text.slice(copied, i)} ${SHIELD_OPEN}${shieldIndex(runs.length)}${SHIELD_CLOSE} `;
      runs.push(end - i - 2);
      copied = end;
    }
    i = end - 1;
  }
  return runs.length ? { text: out + text.slice(copied), runs } : null;
}

/** A run's index in private-use digits, so nothing marked reads as text touches it. */
function shieldIndex(index: number): string {
  return [...String(index)]
    .map((d) => String.fromCharCode(SHIELD_DIGIT_ZERO + Number(d)))
    .join('');
}

/** Put each shielded run back, wherever marked placed its mark. */
function restoreSpaceRuns(html: string, runs: readonly number[]): string {
  return html.replace(SHIELD_MARK, (_, digits: string) => {
    const index = Number(
      [...digits].map((d) => d.charCodeAt(0) - SHIELD_DIGIT_ZERO).join(''),
    );
    return ' '.repeat(runs[index] ?? 0);
  });
}

/** A `:shortcode:` opening; the closing colon is a lookahead so `:a:b:` can still find `:b:`. */
const SHORTCODE = /:([A-Za-z0-9_-]{1,100})(?=:)/g;

/**
 * Each known `:shortcode:` outside code as an MSC2545 inline image. Runs before the outgoing
 * sanitizer, which drops any whose url is not `mxc:` back to its alt text.
 */
function inlineEmoticons(
  html: string,
  emoticons: ReadonlyMap<string, string>,
): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('code, pre')) texts.push(node as Text);
  }
  for (const text of texts) {
    const parts: (string | Node)[] = [];
    let copied = 0;
    for (const match of text.data.matchAll(SHORTCODE)) {
      const url = emoticons.get(match[1]);
      // Overlap: this opening colon closed the previous code.
      if (!url || match.index < copied) continue;
      const code = `:${match[1]}:`;
      const image = doc.createElement('img');
      image.setAttribute('data-mx-emoticon', '');
      image.setAttribute('src', url);
      image.setAttribute('alt', code);
      image.setAttribute('title', code);
      image.setAttribute('height', '32');
      parts.push(text.data.slice(copied, match.index), image);
      copied = match.index + code.length;
    }
    if (copied > 0) text.replaceWith(...parts, text.data.slice(copied));
  }
  return doc.body.innerHTML;
}

/**
 * Render composer markdown to sanitized HTML. `formatted` is false when the HTML
 * carries no formatting beyond the plain text, so the caller can send plain text.
 * `emoticons` maps a shortcode to its mxc url; each known `:shortcode:` becomes an inline image.
 */
export function renderMarkdown(
  text: string,
  emoticons: ReadonlyMap<string, string> = new Map(),
): RenderedMarkdown {
  let rendered: string;
  try {
    const shielded = shieldSpaceRuns(text);
    rendered = shielded
      ? restoreSpaceRuns(
          markdown.parse(shielded.text, { async: false }),
          shielded.runs,
        )
      : markdown.parse(text, { async: false });
  } catch {
    return { formatted: false, html: '' };
  }
  const html = sanitizeOutgoingHtml(
    emoticons.size > 0 ? inlineEmoticons(rendered, emoticons) : rendered,
  );
  // Input whose every construct the allowlist strips (an HTML comment, a lone <script>)
  // sanitizes to nothing; an empty formatted_body is worse than plain text. Callers check `html`
  // as well as `formatted`: a message with a mention takes the rich branch regardless, and an
  // empty formatted_body renders as a blank message, since every client (Element included)
  // prefers it over `body`.
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
 * Plain-text content of an HTML string, with `<br>` restored as a newline.
 *
 * Load-bearing: `textContent` drops `<br>`, so under `breaks: true` every multi-line plain
 * message would compare as rewritten by markdown and be sent as HTML.
 */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const br of doc.body.querySelectorAll('br')) {
    br.replaceWith(doc.createTextNode('\n'));
  }
  return doc.body.textContent ?? '';
}

/**
 * The form both sides of the "did markdown add anything?" comparison are reduced to, with
 * cosmetic whitespace levelled out: CRLF, trailing spaces (markdown's two-space hard break),
 * and runs of blank lines. `body` always carries the author's exact text.
 */
function normaliseForCompare(value: string): string {
  // Trailing blanks are trimmed by a linear walk, not `/[ \t]+$/gm`, which is quadratic on a
  // long blank run that does not end its line. The capture group keeps the separators at odd
  // indexes: the multiline `$` line terminators left once CR is folded into LF.
  const lines = value.replace(/\r\n?/g, '\n').split(/([\n\u2028\u2029])/);
  return lines
    .map((part, index) => (index % 2 === 0 ? trimTrailing(part, ' \t') : part))
    .join('')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
