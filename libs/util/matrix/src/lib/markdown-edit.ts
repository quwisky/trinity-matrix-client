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
  | 'tasklist'
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

/** The actions that rewrite whole lines rather than wrapping a selection. */
type BlockAction = 'quote' | 'list' | 'tasklist';

/** The marker each block action puts on a line. */
const BLOCK_MARKER: Record<BlockAction, string> = {
  quote: '> ',
  list: '- ',
  tasklist: '- [ ] ',
};

/**
 * A list or quote marker at the start of a line: leading indent, then a bullet (`-`/`*`/`+`),
 * an ordered marker (`1.`/`1)`) or a quote (`>`), then at least one space.
 */
const LINE_MARKER = /^(\s*)(?:([-*+])|(\d+)([.)])|(>))\s+/;

/** A GFM task box directly after a bullet marker: `[ ]`, `[x]` or `[X]`, then a space. */
const TASK_BOX = /^\[[ xX]\]\s+/;

/**
 * A whole list-item marker: indent, a bullet (`-`/`*`/`+`) or an ordered marker (`1.`/`1)`),
 * and the task box when there is one. The bullet and the box get their own groups because
 * the three kinds of item are what the block actions toggle between: group 2 is set only for
 * a bullet (not `1.`), group 3 only for a task item.
 */
const LIST_MARKER = /^(\s*)(?:([-*+])|\d+[.)])\s+(\[[ xX]\]\s+)?/;

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
  if (action === 'quote' || action === 'list' || action === 'tasklist') {
    return applyLinePrefix(text, from, to, action);
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
  action: BlockAction,
): EditResult {
  const lineStart = lineStartAt(text, start);
  const nextBreak = text.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;

  const lines = text.slice(lineStart, lineEnd).split('\n');
  const rewritten = rewriteBlock(lines, action);
  // Per-line deltas rather than one width times a count: a rewrite can now SHORTEN a line
  // (`1. a` → `- a`) or change it by something other than the marker's own width
  // (`- a` → `- [ ] a` adds four, not six), so a single step no longer describes the move.
  const deltas = rewritten.map((line, i) => line.length - lines[i].length);
  const selectionStart = Math.max(lineStart, start + deltas[0]);
  return {
    text: text.slice(0, lineStart) + rewritten.join('\n') + text.slice(lineEnd),
    selectionStart,
    selectionEnd: Math.max(
      selectionStart,
      end + deltas.reduce((sum, delta) => sum + delta, 0),
    ),
  };
}

/**
 * Apply `action` to a block of lines: strip its marker when every line already carries that
 * exact one, else bring every line to it.
 *
 * "Bring to it", not "prefix with it". A line already carrying a *different* list marker has
 * that marker replaced, because `- a` and `- [ ] a` are the same thing said two ways and
 * stacking them (`- [ ] - a`) renders as a nested bullet rather than a checked item.
 * Quoting is the exception and stays additive: `> - item` is a list inside a quote, a
 * separate axis rather than a competing marker, so quoting a list must keep the list.
 */
function rewriteBlock(lines: string[], action: BlockAction): string[] {
  // Blank lines are neither marked nor counted. Without this a paragraph break inside the
  // selection makes `allMarked` false forever, so an already-quoted passage can be quoted
  // again but never unquoted. …unless EVERY touched line is blank, which is the empty
  // composer and the blank line mid-draft: there is nothing to toggle off there, and
  // skipping them would make the button do nothing at all.
  const marked = lines.filter((line) => line.trim() !== '');
  const blankBlock = marked.length === 0;
  const allMarked =
    !blankBlock && marked.every((line) => carries(line, action));

  return lines.map((line) => {
    if (!blankBlock && line.trim() === '') {
      return line;
    }
    const { indent, marker, body } = splitBlockLine(line, action);
    if (allMarked) {
      return indent + body;
    }
    // `marker` is dropped rather than kept: for the list family that is the swap, and for a
    // quote it is empty unless the line is already quoted (in which case `allMarked` held).
    return (
      indent +
      BLOCK_MARKER[action] +
      (action === 'quote' ? marker + body : body)
    );
  });
}

/** Whether `line` already carries exactly the marker `action` applies. */
function carries(line: string, action: BlockAction): boolean {
  if (action === 'quote') {
    return line.startsWith(BLOCK_MARKER.quote);
  }
  const match = LIST_MARKER.exec(line);
  if (match === null) {
    return false;
  }
  // Each button toggles off only its OWN kind. A task item is not a plain bullet, and an
  // ordered item is not a bulleted one — pressing Bulleted list on `1. a` means "make this a
  // bulleted list", so it converts rather than clearing the line.
  return action === 'tasklist'
    ? match[3] !== undefined
    : match[2] !== undefined && match[3] === undefined;
}

/** Split `line` into its indent, the marker `action` would replace, and the rest. */
function splitBlockLine(
  line: string,
  action: BlockAction,
): { indent: string; marker: string; body: string } {
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  if (action === 'quote') {
    const rest = line.slice(indent.length);
    const quoted = rest.startsWith(BLOCK_MARKER.quote);
    return {
      indent,
      marker: '',
      body: quoted ? rest.slice(BLOCK_MARKER.quote.length) : rest,
    };
  }
  const match = LIST_MARKER.exec(line);
  return match === null
    ? { indent, marker: '', body: line.slice(indent.length) }
    : {
        indent: match[1],
        marker: match[0].slice(match[1].length),
        body: line.slice(match[0].length),
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
  // A task item's marker is the bullet AND its box: `- [x] ` is what has to be carried,
  // measured and stepped over, or `[x] ` reads as the item's content and an empty task item
  // never looks empty.
  const taskBox = bullet
    ? (TASK_BOX.exec(line.slice(marker.length))?.[0] ?? '')
    : '';
  const fullMarker = marker + taskBox;
  if (line.slice(fullMarker.length).trim() === '') {
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
  if (at < lineStart + fullMarker.length) {
    // The caret is inside the marker of an item that HAS content, where a split would tear
    // the marker in half. An ordinary newline is the safe reading, so leave it to the caller.
    return null;
  }

  // Always an UNCHECKED box: carrying `[x]` across would tick the new item before it exists.
  const next = bullet
    ? `${indent}${bullet} ${taskBox ? '[ ] ' : ''}`
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

/**
 * Turn a message body into a markdown blockquote for the composer to write around.
 *
 * Deliberately NOT {@link applyFormat}'s `'quote'` action, which is the composer button's
 * toggle: that unquotes when every line already carries `>`, so quoting a quote would
 * silently unwrap it, and it leaves blank lines bare — which in CommonMark ENDS the
 * blockquote, so a two-paragraph message would half-escape and render its second half as
 * the quoter's own words. This is unconditional and marks every line.
 *
 * Blank lines get a bare `>` rather than `> ` so the block carries no trailing whitespace.
 *
 * Returns the block plus a blank line, so the caret lands below it ready to type — or `''`
 * for a body with nothing in it, which has no quote worth making.
 */
export function quoteBlock(body: string): string {
  if (body.trim() === '') {
    return '';
  }
  const quoted = body
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `${BLOCK_MARKER.quote}${line}`))
    .join('\n');
  return `${quoted}\n\n`;
}
