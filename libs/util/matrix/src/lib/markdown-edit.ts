/**
 * Editing-side markdown helpers: what a formatting toolbar and a markdown-aware Enter do to
 * the composer's text. Pure and DOM-free: a string and a selection in, a string and a
 * selection out.
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

const INLINE_MARKER: Partial<Record<FormatAction, string>> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
};

/** The actions that rewrite whole lines rather than wrapping a selection. */
type BlockAction = 'quote' | 'list' | 'tasklist';

const BLOCK_MARKER: Record<BlockAction, string> = {
  quote: '> ',
  list: '- ',
  tasklist: '- [ ] ',
};

const BLOCK_ACTIONS: readonly BlockAction[] = ['quote', 'list', 'tasklist'];

/** A list or quote marker at the start of a line, with at least one space after it. */
const LINE_MARKER = /^(\s*)(?:([-*+])|(\d+)([.)])|(>))\s+/;

/** A GFM task box directly after a bullet marker: `[ ]`, `[x]` or `[X]`, then a space. */
const TASK_BOX = /^\[[ xX]\]\s+/;

/** A whole list-item marker. Group 2 is set only for a bullet (not `1.`), group 3 only for a task item. */
const LIST_MARKER = /^(\s*)(?:([-*+])|\d+[.)])\s+(\[[ xX]\]\s+)?/;

/**
 * Where the line containing `index` starts. The guard is needed: `lastIndexOf('\n', -1)`
 * clamps to 0 and matches a newline AT index 0, putting the line start after the caret.
 */
function lineStartAt(text: string, index: number): number {
  return index === 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1;
}

/** How many consecutive `char`s sit at `index`: step -1 walks back from just before it, +1 forwards from it. */
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

/**
 * Which actions `text[start, end)` already carries, for the formatting bar's `aria-pressed`.
 *
 * A reported action is exactly one that {@link applyFormat} would remove, so a lit button
 * never adds a second pair of markers. Both share `wrappedOutside`/`wrappedInside` and
 * `carries`. The converse does not hold: applying can also convert (`list` on `- [ ] one`
 * gives `- one`, so Bulleted list is not pressed on a task item), and `italic` over `**hello**`
 * nests to `***hello***`, which reads as neither bold nor italic.
 *
 * `link` and `codeblock` are never reported: they only insert and never unwrap.
 */
export function detectFormat(
  text: string,
  start: number,
  end: number,
): FormatAction[] {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const active: FormatAction[] = [];

  for (const [action, marker] of Object.entries(INLINE_MARKER)) {
    if (
      wrappedOutside(text, from, to, marker) ||
      wrappedInside(text, from, to, marker)
    ) {
      active.push(action as FormatAction);
    }
  }

  // Reads the lines the selection touches, the same span `applyLinePrefix` rewrites.
  const lineStart = lineStartAt(text, from);
  const nextBreak = text.indexOf('\n', to);
  const lines = text
    .slice(lineStart, nextBreak === -1 ? text.length : nextBreak)
    .split('\n');
  for (const action of BLOCK_ACTIONS) {
    // Every line, matching `rewriteBlock`'s strip condition.
    if (lines.every((line) => carries(line, action))) {
      active.push(action);
    }
  }

  return active;
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
 * Whether `marker` sits immediately OUTSIDE `text[start, end)` — `**|bold|**`.
 *
 * Compares run lengths, not prefixes: `*` is a prefix of `**`, so a prefix test would read the
 * inner asterisk of `**bold**` as italic and strip it.
 */
function wrappedOutside(
  text: string,
  start: number,
  end: number,
  marker: string,
): boolean {
  const char = marker[0];
  return (
    runLength(text, start, -1, char) === marker.length &&
    runLength(text, end, 1, char) === marker.length
  );
}

/** Whether `marker` sits immediately INSIDE the selection — `|**bold**|`. */
function wrappedInside(
  text: string,
  start: number,
  end: number,
  marker: string,
): boolean {
  const char = marker[0];
  return (
    end - start >= marker.length * 2 &&
    runLength(text, start, 1, char) === marker.length &&
    runLength(text, end, -1, char) === marker.length
  );
}

/**
 * Wrap the selection in `marker`, or unwrap it when it is already wrapped (markers just
 * outside or just inside the selection). With no selection the caret lands between the markers.
 */
function applyInline(
  text: string,
  start: number,
  end: number,
  marker: string,
): EditResult {
  const width = marker.length;

  if (wrappedOutside(text, start, end, marker)) {
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

  if (wrappedInside(text, start, end, marker)) {
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
    selectionStart: start + width,
    selectionEnd: end + width,
  };
}

/**
 * Prefix every line the selection touches, or strip the prefix when they all already carry it.
 * Works on whole lines, so selecting the middle of one still means "quote this line".
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
  // Per-line deltas: a rewrite can shorten a line (`1. a` → `- a`) or change it by less than
  // the marker's width (`- a` → `- [ ] a` adds four, not six).
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
 * A line carrying a different list marker has it replaced, since stacking them
 * (`- [ ] - a`) renders as a nested bullet. Quoting stays additive: `> - item` is a list
 * inside a quote.
 */
function rewriteBlock(lines: string[], action: BlockAction): string[] {
  // Blank lines are neither marked nor counted, or a paragraph break would keep `allMarked`
  // false and a quoted passage could never be unquoted. If every line is blank (empty
  // composer), they are processed anyway so the button still does something.
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
    // `marker` is dropped: that is the swap for lists; for a quote it is always empty.
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
  // Each button toggles off only its own kind: Bulleted list on `1. a` converts it.
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

/** A fenced block on its own lines; inline backticks are the separate `code` action. */
function applyCodeBlock(text: string, start: number, end: number): EditResult {
  const selected = text.slice(start, end);
  const before = text.slice(0, start);
  const after = text.slice(end);
  // Only add newlines that are missing, so an empty composer gets no blank first line.
  const lead = before === '' || before.endsWith('\n') ? '' : '\n';
  const tail = after === '' || after.startsWith('\n') ? '' : '\n';

  const opened = `${lead}\`\`\`\n`;
  const closed = `\n\`\`\`${tail}`;
  return {
    text: before + opened + selected + closed + after,
    selectionStart: start + opened.length,
    selectionEnd: start + opened.length + selected.length,
  };
}

/** `[text](url)`: the caret lands in the empty url, or in the empty text with no selection. */
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
 * Continue a list or quote onto a new line, or end it when the line holds only a marker.
 * Returns null when the caret's line carries no marker, leaving the caller to insert an
 * ordinary newline. Ordered markers increment; indentation is carried across.
 */
export function continueList(text: string, caret: number): EditResult | null {
  const at = Math.max(0, Math.min(caret, text.length));
  const lineStart = lineStartAt(text, at);
  const nextBreak = text.indexOf('\n', at);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  // The whole line: "is this item empty?" must not depend on where the caret is.
  const line = text.slice(lineStart, lineEnd);
  const match = LINE_MARKER.exec(line);
  if (!match) {
    return null;
  }

  const [marker, indent, bullet, ordinal, delimiter, quote] = match;
  // A task item's marker includes its box, or `[x] ` reads as content and the item never looks empty.
  const taskBox = bullet
    ? (TASK_BOX.exec(line.slice(marker.length))?.[0] ?? '')
    : '';
  const fullMarker = marker + taskBox;
  if (line.slice(fullMarker.length).trim() === '') {
    // An empty item ends the list. Checked before the caret position: wherever the caret
    // sits in `- `, a second Shift+Enter means "stop".
    const stripped = text.slice(0, lineStart) + text.slice(lineEnd);
    return {
      text: stripped,
      selectionStart: lineStart,
      selectionEnd: lineStart,
    };
  }
  if (at < lineStart + fullMarker.length) {
    // Caret inside the marker of a non-empty item: a split would tear the marker.
    return null;
  }

  // Always an unchecked box: carrying `[x]` across would tick the new item.
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
 * Not {@link applyFormat}'s `'quote'` toggle: that would unwrap a quoted body, and it leaves
 * blank lines bare, which in CommonMark ends the blockquote. This marks every line, with a
 * bare `>` for blank ones. Returns the block plus a blank line, or `''` for an empty body.
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
