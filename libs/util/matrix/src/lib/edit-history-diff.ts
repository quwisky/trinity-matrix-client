import {
  DIFF_DELETE,
  DIFF_INSERT,
  cleanupSemantic,
  makeDiff,
} from '@sanity/diff-match-patch';
import { type MessageRevisionView } from './edit-history';

/**
 * Character-level diff between two versions of a message, applied as highlights on top of
 * the newer version's already-sanitized HTML.
 *
 * ⚠️ The annotated HTML this module returns must NEVER be passed back through
 * `sanitizeMatrixHtml`. That allowlist is the Matrix spec's: it permits `del` but not
 * `ins`, and its attribute hook drops any `class` outside the markdown/spoiler set, so
 * insertions would silently vanish. Re-sanitizing is unnecessary: the input is already
 * sanitized, every wrapper is built with `createElement`, and every piece of text comes
 * from `splitText`/`createTextNode`, so no text can become markup. The `[innerHTML]`
 * binding still runs Angular's own sanitizer over the result.
 */

/** A run of text that is unchanged, added by this edit, or removed by it. */
export type DiffOp =
  | { kind: 'same'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'remove'; text: string };

/**
 * How long the diff may run before diff-match-patch returns a valid but blunter result. A
 * guard, not a tuning knob: a sender can make an edit deliberately expensive to compare
 * within the ~64 KiB event limit.
 */
const DIFF_TIMEOUT_SECONDS = 0.25;

/**
 * Move the whitespace at the edges of an addition out of it, so the highlight does not start
 * a space early. Only additions are peeled; a deletion's whitespace is not in the new text.
 */
function peelEdgeWhitespace(ops: DiffOp[]): DiffOp[] {
  return ops.flatMap((op): DiffOp[] => {
    if (op.kind !== 'add') {
      return [op];
    }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(op.text) ?? [];
    if (core === undefined || core === '') {
      return [op];
    }
    return [
      ...(lead ? [{ kind: 'same' as const, text: lead }] : []),
      { kind: 'add' as const, text: core },
      ...(trail ? [{ kind: 'same' as const, text: trail }] : []),
    ];
  });
}

/** Merge neighbouring ops of one kind, and don't highlight a lone run of whitespace. */
function tidy(rawOps: DiffOp[]): DiffOp[] {
  const ops = peelEdgeWhitespace(rawOps);
  const tidied: DiffOp[] = [];
  for (const original of ops) {
    if (original.text === '') {
      continue;
    }
    // A highlighted lone space says nothing: fold an added one back, drop a removed one.
    const isolatedWhitespace =
      original.kind !== 'same' &&
      /^\s+$/.test(original.text) &&
      tidied[tidied.length - 1]?.kind !== original.kind;
    if (isolatedWhitespace && original.kind === 'remove') {
      continue;
    }
    const op: DiffOp = isolatedWhitespace
      ? { kind: 'same', text: original.text }
      : original;
    const last = tidied[tidied.length - 1];
    if (last?.kind === op.kind) {
      last.text += op.text;
    } else {
      tidied.push({ ...op });
    }
  }
  return tidied;
}

/**
 * Character-level diff of two strings, oldest first. `cleanupSemantic` merges the slivers a
 * raw character diff produces into word-sized runs.
 */
export function diffTokens(previous: string, current: string): DiffOp[] {
  // Precomposed and decomposed "café" differ as code units, which the library compares, so
  // normalise first or the same word typed on two platforms diffs as delete plus insert.
  const diffs = cleanupSemantic(
    makeDiff(previous.normalize('NFC'), current.normalize('NFC'), {
      timeout: DIFF_TIMEOUT_SECONDS,
    }),
  );
  return tidy(
    diffs.map(([type, text]) => ({
      kind:
        type === DIFF_INSERT ? 'add' : type === DIFF_DELETE ? 'remove' : 'same',
      text,
    })),
  );
}

/** Every text node under `root`, with where each sits in the concatenated text. */
function textSpans(
  root: HTMLElement,
): { node: Text; start: number; end: number }[] {
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
  );
  const spans: { node: Text; start: number; end: number }[] = [];
  let offset = 0;
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    spans.push({ node, start: offset, end: offset + node.data.length });
    offset += node.data.length;
  }
  return spans;
}

/** Wrap the characters in `[from, to)` — which may span several nodes — in `<ins>`. */
function markAdded(
  spans: { node: Text; start: number; end: number }[],
  from: number,
  to: number,
): void {
  for (const span of [...spans].reverse()) {
    const start = Math.max(from, span.start);
    const end = Math.min(to, span.end);
    if (start >= end) {
      continue;
    }
    if (end < span.end) {
      span.node.splitText(end - span.start);
    }
    const target =
      start > span.start ? span.node.splitText(start - span.start) : span.node;
    const wrapper = target.ownerDocument.createElement('ins');
    wrapper.className = 'diff-ins';
    target.parentNode?.replaceChild(wrapper, target);
    wrapper.appendChild(target);
  }
}

/**
 * Put the removed text back, struck through, where it used to sit.
 *
 * In code blocks the removed run is ONE `<del>` at a single offset, so a multi-line removal
 * lands inside one `<span class="code-line">`. Nothing here re-sanitizes, so the wrappers
 * cannot be re-derived; rendered-markdown.scss suppresses line numbering for a diffed
 * revision rather than under-count.
 */
function markRemoved(
  root: HTMLElement,
  spans: { node: Text; start: number; end: number }[],
  at: number,
  text: string,
): void {
  const removed = root.ownerDocument.createElement('del');
  removed.className = 'diff-del';
  removed.textContent = text;

  const span = spans.find((s) => at >= s.start && at < s.end);
  if (!span) {
    root.append(removed); // the edit trimmed the end of the message
    return;
  }
  const tail =
    at > span.start ? span.node.splitText(at - span.start) : span.node;
  // A replacement's removal shares an offset with the already-wrapped insertion; landing
  // inside that wrapper would read as "added, and also struck through".
  let anchor: Node = tail;
  while (
    anchor.parentElement &&
    anchor.parentElement !== root &&
    /^(?:ins|del)$/i.test(anchor.parentElement.tagName) &&
    anchor.parentElement.className.startsWith('diff-')
  ) {
    anchor = anchor.parentElement;
  }
  anchor.parentNode?.insertBefore(removed, anchor);
}

/**
 * Show each formula as its LaTeX source, in the `code.mx-maths-source` the maths directive
 * uses for one it cannot render. Rendered KaTeX boxes are inline-blocks that an underline or
 * strike-through does not reach, so a changed formula would be marked by colour alone. The
 * element keeps its tag, so display maths stays a block, and loses `mx-maths`, so the
 * directive leaves it as text.
 */
function mathsAsSource(root: Element): void {
  const formulas = [...root.querySelectorAll('.mx-maths')].filter(
    (maths) => !maths.parentElement?.closest('.mx-maths'),
  );
  for (const maths of formulas) {
    const code = root.ownerDocument.createElement('code');
    code.className = 'mx-maths-source';
    code.textContent = maths.getAttribute('data-mx-maths') ?? '';
    maths.classList.remove('mx-maths');
    maths.replaceChildren(code);
  }
}

/** The text a revision reads as, ignoring its markup; a formula reads as its LaTeX. */
function plainTextOf(html: string, body: string): string {
  if (!html) {
    return body;
  }
  const root = new DOMParser().parseFromString(
    `<div>${html}</div>`,
    'text/html',
  ).body.firstElementChild;
  if (!root) {
    return body;
  }
  mathsAsSource(root);
  return root.textContent ?? body;
}

/**
 * Annotate `current` with what changed since `previous`: its own HTML, with added runs
 * wrapped in `<ins class="diff-ins">` and removed runs re-inserted as
 * `<del class="diff-del">`. Returns null when the two read identically, or either side is
 * undecryptable (its body is a fixed notice).
 *
 * Only text nodes are split or wrapped, so the tree cannot come out malformed. Removed text
 * has no node in the new tree: it loses its own formatting and takes that of the element at
 * the offset it is re-inserted at.
 */
export function annotateRevision(
  previous: MessageRevisionView,
  current: MessageRevisionView,
): string | null {
  if (previous.kind === 'undecryptable' || current.kind === 'undecryptable') {
    return null;
  }
  const previousText = plainTextOf(previous.html ?? '', previous.body);
  const currentText = plainTextOf(current.html ?? '', current.body);
  if (previousText === currentText) {
    return null; // an edit that only changed formatting, or nothing at all
  }

  const ops = diffTokens(previousText, currentText);
  if (!ops.some((op) => op.kind !== 'same')) {
    return null;
  }

  // A plain-text revision goes through the same path via a text node.
  const doc = new DOMParser().parseFromString('<div></div>', 'text/html');
  const root = doc.body.firstElementChild as HTMLElement;
  if (current.html) {
    root.innerHTML = current.html;
    mathsAsSource(root);
  } else {
    root.append(doc.createTextNode(current.body));
  }

  const spans = textSpans(root);
  let cursor = 0;
  const placed = ops.map((op) => {
    const at = cursor;
    if (op.kind !== 'remove') {
      cursor += op.text.length;
    }
    return { op, at, end: cursor };
  });

  // Applied back to front so each op's offsets are still valid when it is applied.
  for (const { op, at, end } of [...placed].reverse()) {
    if (op.kind === 'add') {
      markAdded(spans, at, end);
    } else if (op.kind === 'remove') {
      markRemoved(root, spans, at, op.text);
    }
  }
  return root.innerHTML;
}
