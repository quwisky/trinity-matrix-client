import {
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  signal,
} from '@angular/core';

type Highlight = typeof import('./code-highlight').highlightLines;

/** Total characters of code one message body may have tokenized (blocks cap themselves). */
const MAX_CHARS_PER_BODY = 20_000;

const highlighter = signal<Highlight | null>(null);
let requested = false;

/** Fetch the grammars once, on the first rendered code block. */
function load(): void {
  if (requested) {
    return;
  }
  requested = true;
  import('./code-highlight').then(
    (module) => highlighter.set(module.highlightLines),
    // Plain code is a fine permanent fallback; allow a retry on the next render.
    () => (requested = false),
  );
}

const languageOf = (code: Element): string | null =>
  /(?:^|\s)language-([\w-]+)(?:\s|$)/
    .exec(code.className)?.[1]
    ?.toLowerCase() ?? null;

/**
 * Syntax-highlights the fenced blocks of a sanitized message body that is rendered with
 * `[innerHTML]`. The sanitizer leaves code as plain text, so a row shows readable code at
 * once and this swaps colours in (same characters, same layout) when Shiki has loaded —
 * only for rows that are actually on screen. Output is built from createElement and
 * textContent, never markup.
 */
@Directive({ selector: '[trnCodeHighlight]' })
export class CodeHighlightDirective {
  readonly source = input('', { alias: 'trnCodeHighlight' });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterRenderEffect(() => {
      this.source();
      const highlight = highlighter();
      const blocks = [
        ...this.host.nativeElement.querySelectorAll('pre > code'),
      ].filter((code) => languageOf(code));
      if (blocks.length === 0) {
        return;
      }
      if (!highlight) {
        load();
        return;
      }
      let budget = MAX_CHARS_PER_BODY;
      for (const code of blocks) {
        budget -= apply(code, highlight, budget);
      }
    });
  }
}

/** Tokenize one block in place; returns the characters spent. */
function apply(code: Element, highlight: Highlight, budget: number): number {
  const source = code.textContent ?? '';
  const wrappers = [...code.children];
  // Sender markup (a link, bold) or an already highlighted block: leave it alone.
  const plain = wrappers.every(
    (line) =>
      line.classList.contains('code-line') && line.children.length === 0,
  );
  if (!plain || !source || source.length > budget) {
    return 0;
  }
  const lines = highlight(source, languageOf(code) ?? '', code.ownerDocument);
  if (!lines) {
    return 0;
  }
  if (wrappers.length === 0) {
    const doc = code.ownerDocument;
    code.replaceChildren(
      ...lines.flatMap((line, i) =>
        i ? [doc.createTextNode('\n'), line] : [line],
      ),
    );
  } else if (wrappers.length <= lines.length) {
    wrappers.forEach((wrapper, i) => wrapper.replaceChildren(lines[i]));
  } else {
    return 0;
  }
  return source.length;
}
