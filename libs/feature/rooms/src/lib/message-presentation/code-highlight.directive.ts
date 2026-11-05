import {
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
} from '@angular/core';
import { linesFromRuns } from './code-lines';
import { resolveLanguage, type CodeLanguage } from './code-languages';
import {
  HighlightFallback,
  HighlightWorker,
} from './code-highlight.worker-client';

type Highlighter = typeof import('./code-highlight');

/** Total characters of code one message body may have tokenized (blocks cap themselves). */
const MAX_CHARS_PER_BODY = 20_000;

const languageOf = (code: Element): CodeLanguage | null => {
  const fence = /(?:^|\s)language-([\w-]+)(?:\s|$)/.exec(code.className)?.[1];
  return fence ? resolveLanguage(fence) : null;
};

/**
 * Syntax-highlights the fenced blocks of a sanitized message body rendered with `[innerHTML]`.
 * The sanitizer leaves code as plain text, so a row shows readable code at once and this swaps
 * colours in (same characters, same layout) when its tokens arrive, only for rows on screen.
 * Tokenizing runs in the highlight worker; where it cannot start, or after it fails, the main
 * thread loads the grammars and tokenizes instead. Output is built from createElement and
 * textContent, never markup.
 */
@Directive({ selector: '[trnCodeHighlight]' })
export class CodeHighlightDirective {
  readonly source = input('', { alias: 'trnCodeHighlight' });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly worker = inject(HighlightWorker);
  private readonly fallback = inject(HighlightFallback);

  constructor() {
    afterRenderEffect(() => {
      this.source();
      this.worker.retryTick();
      const highlighter = this.fallback.core();
      const ready = this.fallback.registered();
      const blocks = [
        ...this.host.nativeElement.querySelectorAll('pre > code'),
      ].flatMap((code) => {
        const language = languageOf(code);
        return language ? [{ code, language }] : [];
      });
      if (blocks.length === 0) {
        return;
      }
      const client = this.worker.client();
      if (client.available()) {
        let budget = MAX_CHARS_PER_BODY;
        for (const { code, language } of blocks) {
          const source = code.textContent ?? '';
          if (!source || source.length > budget) continue;
          // Highlighted blocks keep their share of the budget, so every run charges the same.
          if (isHighlighted(code)) budget -= source.length;
          if (!isPlain(code)) continue;
          budget -= source.length;
          if (this.worker.sent.get(code) === source) continue;
          this.worker.sent.set(code, source);
          void client.request(language.id, source).then((result) => {
            // The row was re-rendered or edited while the worker ran: its reply is stale.
            if (!code.isConnected || code.textContent !== source) return;
            if (result.kind === 'retry') {
              this.worker.retryLater(code);
              return;
            }
            if (result.kind !== 'lines' || !isPlain(code)) return;
            const lines = linesFromRuns(
              result.lines,
              source,
              code.ownerDocument,
            );
            if (lines) place(code, lines);
          });
        }
        return;
      }
      if (!highlighter) {
        this.fallback.loadCore();
        return;
      }
      let budget = MAX_CHARS_PER_BODY;
      for (const { code, language } of blocks) {
        if (ready.has(language.id)) {
          budget -= apply(code, language.id, highlighter, budget);
        } else {
          this.fallback.loadLanguage(highlighter, language);
        }
      }
    });
  }
}

/** A block this directive already coloured. */
function isHighlighted(code: Element): boolean {
  return code.querySelector('[class^="tok-"]') !== null;
}

/** Sender markup (a link, bold) or an already highlighted block is left alone. */
function isPlain(code: Element): boolean {
  return [...code.children].every(
    (line) =>
      line.classList.contains('code-line') && line.children.length === 0,
  );
}

/** Put highlighted lines into the block's line wrappers, or replace its text when it has none. */
function place(code: Element, lines: DocumentFragment[]): boolean {
  const wrappers = [...code.children];
  if (wrappers.length === 0) {
    const doc = code.ownerDocument;
    code.replaceChildren(
      ...lines.flatMap((line, i) =>
        i ? [doc.createTextNode('\n'), line] : [line],
      ),
    );
    return true;
  }
  if (wrappers.length <= lines.length) {
    wrappers.forEach((wrapper, i) => wrapper.replaceChildren(lines[i]));
    return true;
  }
  return false;
}

/** Tokenize one block in place on the main thread; returns the characters spent. */
function apply(
  code: Element,
  id: string,
  highlighter: Highlighter,
  budget: number,
): number {
  const source = code.textContent ?? '';
  // Highlighted blocks keep their share of the budget, so every run charges the same.
  if (isHighlighted(code)) return source.length;
  if (!isPlain(code) || !source || source.length > budget) {
    return 0;
  }
  const lines = highlighter.highlightLines(source, id, code.ownerDocument);
  return lines && place(code, lines) ? source.length : 0;
}
