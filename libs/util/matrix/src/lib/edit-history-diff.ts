import {
  DIFF_DELETE,
  DIFF_INSERT,
  cleanupSemantic,
  makeDiff,
} from '@sanity/diff-match-patch';
import { type MessageRevisionView } from './edit-history';

/**
 * Character-level diff between two versions of a message, applied as highlights on top of
 * the newer version's already-sanitized HTML — so a past revision keeps its formatting
 * while showing what the edit changed.
 *
 * The diff itself comes from `@sanity/diff-match-patch` (Apache-2.0, no dependencies): a
 * maintained TypeScript rewrite of Google's algorithm. It is worth the dependency for two
 * things that are easy to get subtly wrong by hand — `cleanupSemantic`, which merges the
 * slivers a raw character diff produces into runs a person can read, and its surrogate-pair
 * adjustment, which stops a diff boundary cutting an emoji in half.
 *
 * ⚠️ The annotated HTML this module returns must NEVER be passed back through
 * `sanitizeMatrixHtml`. That allowlist is the Matrix spec's: it permits `del` but not
 * `ins`, and its attribute hook drops any `class` outside the markdown/spoiler set. Doing
 * so would leave deletions rendering while insertions silently vanished — a failure that
 * looks like a CSS bug and isn't. It doesn't need re-sanitizing: the input is already
 * sanitized, every wrapper is built with `createElement`, and every piece of text comes
 * from `splitText`/`createTextNode`, so no text can become markup. The `[innerHTML]`
 * binding still runs Angular's own sanitizer over the result, as it does today.
 */

/** A run of text that is unchanged, added by this edit, or removed by it. */
export type DiffOp =
  | { kind: 'same'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'remove'; text: string };

/**
 * How long the diff may spend before it settles for a coarser answer. Message length is
 * bounded only by the ~64 KiB event limit and nothing stops a sender making an edit
 * deliberately expensive to compare, so this is a guard, not a tuning knob: past the
 * deadline diff-match-patch returns a valid but blunter diff rather than running on.
 * A quarter second is far more than any real edit needs and imperceptible in a dialog.
 */
const DIFF_TIMEOUT_SECONDS = 0.25;

/**
 * Move the whitespace at the edges of an addition out of it. "added ` morning`" would
 * otherwise draw its highlight starting a space early, which reads as a stray gap before
 * the word. Only additions are peeled: their whitespace is genuinely part of the new text,
 * so it becomes an unchanged run, whereas a deletion's is not there to move.
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
    // A highlighted space renders as a small blank box that says nothing; fold it back
    // into the surrounding text (an added one) or drop it (a removed one).
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
 * Character-level diff of two strings, oldest first.
 *
 * `cleanupSemantic` is what makes the result readable rather than merely correct: raw
 * character diffs fragment into confetti on text that repeats letters, and it merges
 * those slivers back into the word-sized runs a person actually reads.
 */
export function diffTokens(previous: string, current: string): DiffOp[] {
  // Precomposed "café" and decomposed "café" are different strings; without this the
  // same word typed on two platforms reads as a delete plus an insert. The library
  // compares code units, so this has to happen before it sees them.
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

/** Put the removed text back, struck through, where it used to sit. */
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
  // A replacement puts the removal at the same offset as the insertion that took its
  // place, and that text has already been wrapped. Landing inside the wrapper would read
  // as "added, and also struck through" — the removed words belong beside it, not in it.
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

/** The text a revision reads as, ignoring its markup. */
function plainTextOf(html: string, body: string): string {
  if (!html) {
    return body;
  }
  const parsed = new DOMParser().parseFromString(
    `<div>${html}</div>`,
    'text/html',
  );
  return parsed.body.firstElementChild?.textContent ?? body;
}

/**
 * Annotate `current` with what changed since `previous`: its own HTML, with added runs
 * wrapped in `<ins class="diff-ins">` and removed runs re-inserted as
 * `<del class="diff-del">`. Returns null when there is nothing useful to show — the two
 * read identically, or either side is a version we couldn't decrypt (its body is a fixed
 * notice, so diffing against it would be noise).
 *
 * Only text nodes are ever split or wrapped: no element is moved, cloned or re-attributed,
 * so the annotated tree cannot come out malformed.
 *
 * Removed text is the one place fidelity is lost, in both directions: it has no node in
 * the new tree, so it neither keeps the formatting it had nor escapes the formatting of
 * whichever element holds the offset it is re-inserted at. Turning highlighting off in the
 * dialog gives back the exact as-sent rendering.
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

  // Build the tree from the revision's own HTML so its formatting survives; a plain-text
  // revision goes through the same path via a text node, so there is one code path.
  const doc = new DOMParser().parseFromString('<div></div>', 'text/html');
  const root = doc.body.firstElementChild as HTMLElement;
  if (current.html) {
    root.innerHTML = current.html;
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
