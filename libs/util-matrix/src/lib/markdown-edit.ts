/**
 * Editing-side markdown helpers: what a formatting toolbar and a markdown-aware Enter do to
 * the composer's text. The counterpart to `message-content.ts`, which owns the other
 * direction (markdown → HTML on the way out).
 *
 * Deliberately pure and DOM-free — they take a string and a selection and return a string and
 * a selection. The composer owns the textarea; these own the string arithmetic, which is where
 * every off-by-one lives.
 */

/** A formatting action a toolbar button or shortcut can apply. */
export type FormatAction =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'codeblock'
  | 'quote'
  | 'list'
  | 'link';

/** The text and selection a composer should adopt after an edit. */
export interface EditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/** The paired markers for each inline action. */
const INLINE_MARKER: Partial<Record<FormatAction, string>> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
};

/** The line prefix for each block action. */
const LINE_PREFIX: Partial<Record<FormatAction, string>> = {
  quote: '> ',
  list: '- ',
};

/**
 * A list or quote marker at the start of a line: leading indent, then a bullet (`-`/`*`/`+`),
 * an ordered marker (`1.`/`1)`) or a quote (`>`), then at least one space.
 */
const LINE_MARKER = /^(\s*)(?:([-*+])|(\d+)([.)])|(>))\s+/;

/**
 * Where the line containing `index` starts.
 *
 * The guard is the point: `lastIndexOf('\n', index - 1)` with `index === 0` clamps the search
 * position to 0 and so matches a newline sitting AT index 0 — putting the line start *after*
 * the caret. A draft opening with a blank line then had its block read one line down, and the
 * slices either side of it overlapped and duplicated the break.
 */
function lineStartAt(text: string, index: number): number {
  return index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
}

/**
 * How many consecutive `char`s sit at `index`, walking in `step` (-1 = backwards from just
 * before `index`, +1 = forwards from `index`).
 */
function runLength(
  text: string,
  index: number,
  step: -1 | 1,
  char: string,
): number {
  let count = 0;
  let at = step === -1 ? index - 1 : index;
  while (at >= 0 && at < text.length && text[at] === char) {
    count++;
    at += step;
  }
  return count;
}

/** Apply `action` to `text[start, end)`, returning the new text and where to leave the caret. */
export function applyFormat(
  text: string,
  start: number,
  end: number,
  action: FormatAction,
): EditResult {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));

  if (action === 'link') {
    return applyLink(text, from, to);
  }
  if (action === 'codeblock') {
    return applyCodeBlock(text, from, to);
  }
  const prefix = LINE_PREFIX[action];
  if (prefix) {
    return applyLinePrefix(text, from, to, prefix);
  }
  return applyInline(text, from, to, INLINE_MARKER[action] ?? '');
}

/**
 * Wrap the selection in `marker`, or unwrap it when it is already wrapped — toggling off is
 * what pressing a pressed-looking button implies. Handles the markers being just outside the
 * selection (the user selected the word) as well as just inside it (they selected the markup
 * too). With no selection, the markers are inserted and the caret is left between them.
 */
function applyInline(
  text: string,
  start: number,
  end: number,
  marker: string,
): EditResult {
  const width = marker.length;
  const char = marker[0];

  // Runs, not prefixes. Every marker is a repeat of one character, and `*` is a prefix of
  // `**` — so a prefix test would read the inner asterisk of `**bold**` as italic and strip
  // it. Requiring the run to be EXACTLY this wide keeps the markers distinguishable: italic
  // over `**bold**` nests to `***bold***`, while bold over it unwraps.
  const outsideWrapped =
    runLength(text, start, -1, char) === width &&
    runLength(text, end, 1, char) === width;
  if (outsideWrapped) {
    const stripped =
      text.slice(0, start - width) +
      text.slice(start, end) +
      text.slice(end + width);
    return {
      text: stripped,
      selectionStart: start - width,
      selectionEnd: end - width,
    };
  }

  const insideWrapped =
    end - start >= width * 2 &&
    runLength(text, start, 1, char) === width &&
    runLength(text, end, -1, char) === width;
  if (insideWrapped) {
    const stripped =
      text.slice(0, start) +
      text.slice(start + width, end - width) +
      text.slice(end);
    return {
      text: stripped,
      selectionStart: start,
      selectionEnd: end - width * 2,
    };
  }

  const wrapped =
    text.slice(0, start) +
    marker +
    text.slice(start, end) +
    marker +
    text.slice(end);
  return {
    text: wrapped,
    // An empty selection leaves the caret between the markers, ready to type into; a real
    // one keeps the selected words selected so the next action composes.
    selectionStart: start + width,
    selectionEnd: end + width,
  };
}

/**
 * Prefix every line the selection touches, or strip the prefix when they all already carry it.
 * Whole lines, not the raw selection: a quote or a bullet applies to a line, and selecting the
 * middle of one still means "quote this line".
 */
function applyLinePrefix(
  text: string,
  start: number,
  end: number,
  prefix: string,
): EditResult {
  const lineStart = lineStartAt(text, start);
  const nextBreak = text.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;

  const lines = text.slice(lineStart, lineEnd).split('\n');
  // Blank lines are neither prefixed nor counted. Without this a paragraph break inside the
  // selection makes `allPrefixed` false forever, so an already-quoted passage can be quoted
  // again but never unquoted.
  const marked = lines.filter((line) => line.trim() !== '');
  // …unless EVERY touched line is blank, which is the empty composer and the blank line in
  // the middle of a draft. There is nothing to toggle off there, and skipping them would
  // make the button do nothing at all — so the blank lines take the prefix themselves.
  const blankBlock = marked.length === 0;
  const allPrefixed =
    !blankBlock && marked.every((line) => line.startsWith(prefix));
  const changes = (line: string) => blankBlock || line.trim() !== '';
  const next = lines
    .map((line) => {
      if (!changes(line)) {
        return line;
      }
      return allPrefixed ? line.slice(prefix.length) : prefix + line;
    })
    .join('\n');

  const step = allPrefixed ? -prefix.length : prefix.length;
  const changed = lines.filter(changes).length;
  // The caret only moves if the line it sits on actually gained or lost a prefix. Shifting
  // it unconditionally put it mid-prefix (on the `>` of `> `) when the first touched line
  // was blank, and ran `selectionStart` past `selectionEnd` when nothing changed at all.
  const firstDelta = changes(lines[0]) ? step : 0;
  const selectionStart = Math.max(lineStart, start + firstDelta);
  return {
    text: text.slice(0, lineStart) + next + text.slice(lineEnd),
    selectionStart,
    selectionEnd: Math.max(selectionStart, end + step * changed),
  };
}

/**
 * A fenced block on its own lines. Always fenced rather than inline backticks — `code` is the
 * separate action for that, and a block is what someone reaches for when pasting a listing.
 */
function applyCodeBlock(text: string, start: number, end: number): EditResult {
  const selected = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  // Only add the surrounding newlines that are not already there, so applying this at the
  // start of an empty composer does not leave a blank first line.
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const tail = after === '' || after.startsWith('\n') ? '' : '\n';

  const opened = `${lead}\`\`\`\n`;
  const closed = `\n\`\`\`${tail}`;
  return {
    text: before + opened + selected + closed + after,
    // Caret after the opening fence, on the language line's next row — where the code goes.
    selectionStart: start + opened.length,
    selectionEnd: start + opened.length + selected.length,
  };
}

/**
 * `[text](url)`. With a selection the selected words become the link text and the caret lands
 * in the empty url, which is the part that still has to be typed; with no selection the caret
 * lands in the empty text instead.
 */
function applyLink(text: string, start: number, end: number): EditResult {
  const selected = text.slice(start, end);
  const next = `${text.slice(0, start)}[${selected}]()${text.slice(end)}`;
  const caret =
    selected === ''
      ? start + 1 // inside the empty [ ]
      : start + selected.length + 3; // inside the empty ( )
  return { text: next, selectionStart: caret, selectionEnd: caret };
}

/**
 * Continue a list or quote onto a new line, the way a document editor does — or end it.
 *
 * Returns null when the caret's line carries no marker, leaving the caller to insert an
 * ordinary newline. When the line holds *only* a marker, the marker is removed instead: that
 * is how a list ends, and it is why this cannot simply always append.
 *
 * Ordered markers increment; indentation is carried across so a nested item stays nested.
 */
export function continueList(text: string, caret: number): EditResult | null {
  const at = Math.max(0, Math.min(caret, text.length));
  const lineStart = lineStartAt(text, at);
  const nextBreak = text.indexOf('\n', at);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  // The WHOLE line, not just the text before the caret. "Is this item empty?" is a property
  // of the line: reading only the leading half made a caret parked after the marker of a
  // full item look like an empty one, and ended the list by deleting the marker instead of
  // splitting the item in two.
  const line = text.slice(lineStart, lineEnd);
  const match = LINE_MARKER.exec(line);
  if (!match) {
    return null;
  }

  const [marker, indent, bullet, ordinal, delimiter, quote] = match;
  if (line.slice(marker.length).trim() === '') {
    // An empty item: end the list rather than adding another one. Tested before the caret
    // position, because an item with nothing in it has no marker left to tear — wherever
    // the caret sits in `- `, the second Shift+Enter means "stop".
    const stripped = text.slice(0, lineStart) + text.slice(lineEnd);
    return {
      text: stripped,
      selectionStart: lineStart,
      selectionEnd: lineStart,
    };
  }
  if (at < lineStart + marker.length) {
    // The caret is inside the marker of an item that HAS content, where a split would tear
    // the marker in half. An ordinary newline is the safe reading, so leave it to the caller.
    return null;
  }

  const next = bullet
    ? `${indent}${bullet} `
    : quote
      ? `${indent}${quote} `
      : `${indent}${Number(ordinal) + 1}${delimiter} `;

  const inserted = `\n${next}`;
  return {
    text: text.slice(0, at) + inserted + text.slice(at),
    selectionStart: at + inserted.length,
    selectionEnd: at + inserted.length,
  };
}
