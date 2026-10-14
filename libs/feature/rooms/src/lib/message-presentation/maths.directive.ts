import {
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  signal,
} from '@angular/core';
import type { MathsOutcome } from './maths-render';

type MathsRenderer = typeof import('./maths-render').renderMaths;

/** Expressions one message may render; the rest show their LaTeX source (spec B). */
export const MAX_MATHS_PER_MESSAGE = 50;

/** The non-injected styles bundle `apps/trinity/project.json` emits for KaTeX (Task 16). */
const KATEX_STYLESHEET = 'katex.css';

const renderer = signal<MathsRenderer | null>(null);
let requested = false;

/** Fetch KaTeX and its stylesheet once, on the first rendered body that holds maths. */
function load(doc: Document): void {
  if (requested) {
    return;
  }
  requested = true;
  addStylesheet(doc);
  import('./maths-render').then(
    (module) => renderer.set(module.renderMaths),
    // The sender's fallback is a fine permanent state; allow a retry on the next render.
    () => (requested = false),
  );
}

function addStylesheet(doc: Document): void {
  if (doc.head.querySelector('link[data-trinity-katex]')) {
    return;
  }
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = KATEX_STYLESHEET;
  link.setAttribute('data-trinity-katex', '');
  doc.head.append(link);
}

/** Maths nested in maths renders with its outermost expression. */
const outermost = (element: Element): boolean =>
  !element.parentElement?.closest('.mx-maths');

/**
 * Renders the maths of a sanitized message body with KaTeX (spec B). Nothing loads until a
 * rendered body holds `.mx-maths`; then the KaTeX chunk and stylesheet load once, and each
 * expression is rendered from the LaTeX re-read in the sanitized string — parsed once per body,
 * paired with the live elements in document order. At most {@link MAX_MATHS_PER_MESSAGE}
 * render; the rest, and anything KaTeX rejects, show their source as code.
 */
@Directive({ selector: '[trnMaths]' })
export class MathsDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly source = input('', { alias: 'trnMaths' });

  constructor() {
    afterRenderEffect(() => {
      const source = this.source();
      const render = renderer();
      const live = [
        ...this.host.nativeElement.querySelectorAll('.mx-maths'),
      ].filter(outermost);
      if (live.length === 0) {
        return;
      }
      if (!render) {
        load(this.host.nativeElement.ownerDocument);
        return;
      }
      const declared = [
        ...new DOMParser()
          .parseFromString(source, 'text/html')
          .querySelectorAll('.mx-maths'),
      ].filter(outermost);
      live.forEach((element, index) => {
        const latex = declared[index]?.getAttribute('data-mx-maths') ?? '';
        if (!latex) {
          return;
        }
        const outcome: MathsOutcome =
          index < MAX_MATHS_PER_MESSAGE
            ? render(latex, element.nodeName === 'DIV')
            : { kind: 'source' };
        show(element, outcome, latex);
      });
    });
  }
}

function show(element: Element, outcome: MathsOutcome, latex: string): void {
  switch (outcome.kind) {
    case 'rendered':
      element.replaceChildren(outcome.fragment);
      return;
    case 'source': {
      const code = element.ownerDocument.createElement('code');
      code.className = 'mx-maths-source';
      code.textContent = latex;
      element.replaceChildren(code);
      return;
    }
    default: {
      const unhandled: never = outcome;
      void unhandled;
    }
  }
}
