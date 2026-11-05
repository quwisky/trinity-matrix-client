import {
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  signal,
} from '@angular/core';
import { linesFromRuns } from './code-lines';
import { resolveLanguage, type CodeLanguage } from './code-languages';
import { HighlightWorker } from './code-highlight.worker-client';

type Highlighter = typeof import('./code-highlight');

/** Total characters of code one message body may have tokenized (blocks cap themselves). */
const MAX_CHARS_PER_BODY = 20_000;

const core = signal<Highlighter | null>(null);
/** Language ids whose grammar is registered; replaced, never mutated, so effects re-run. */
const registered = signal<ReadonlySet<string>>(new Set());
const inFlight = new Set<string>();
let coreRequested = false;
/** The text each block was last sent to the worker with, so a re-render does not resend it. */
const sent = new WeakMap<Element, string>();

/** Fetch highlight.js core once, on the first rendered block in a known language. */
function loadCore(): void {
  if (coreRequested) {
    return;
  }
  coreRequested = true;
  import('./code-highlight').then(
    (module) => core.set(module),
    // Plain code is a fine permanent fallback; allow a retry on the next render.
    () => (coreRequested = false),
  );
}

/** Fetch one grammar once; a failed fetch is forgotten so a later render retries it. */
function loadLanguage(highlighter: Highlighter, language: CodeLanguage): void {
  if (inFlight.has(language.id) || registered().has(language.id)) {
    return;
  }
  inFlight.add(language.id);
  language.load().then(
    (module) => {
      inFlight.delete(language.id);
      highlighter.registerLanguage(language.id, module.default);
      registered.update((ids) => new Set(ids).add(language.id));
    },
    () => inFlight.delete(language.id),
  );
}

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

  constructor() {
    afterRenderEffect(() => {
      this.source();
      const highlighter = core();
      const ready = registered();
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
          if (!isPlain(code) || !source || source.length > budget) continue;
          budget -= source.length;
          if (sent.get(code) === source) continue;
          sent.set(code, source);
          void client.request(language.id, source).then((runs) => {
            // The row was re-rendered or edited while the worker ran: its reply is stale.
            if (!runs || !code.isConnected || code.textContent !== source)
              return;
            const lines = linesFromRuns(runs, source, code.ownerDocument);
            if (lines && isPlain(code)) place(code, lines);
          });
        }
        return;
      }
      if (!highlighter) {
        loadCore();
        return;
      }
      let budget = MAX_CHARS_PER_BODY;
      for (const { code, language } of blocks) {
        if (ready.has(language.id)) {
          budget -= apply(code, language.id, highlighter, budget);
        } else {
          loadLanguage(highlighter, language);
        }
      }
    });
  }
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
  if (!isPlain(code) || !source || source.length > budget) {
    return 0;
  }
  const lines = highlighter.highlightLines(source, id, code.ownerDocument);
  return lines && place(code, lines) ? source.length : 0;
}
