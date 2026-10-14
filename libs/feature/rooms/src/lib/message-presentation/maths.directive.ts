import {
  DestroyRef,
  Directive,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
} from '@angular/core';
import { MathsLoader } from './maths-loader';
import type { MathsOutcome } from './maths-render';

/** Expressions one message may render; the rest show their LaTeX source (spec B). */
export const MAX_MATHS_PER_MESSAGE = 50;

/**
 * Inline maths with a run wider than its body (KaTeX never wraps inside a run): the stylesheet
 * makes it its own sideways scroller instead of letting it overflow the body.
 */
export const WIDE_MATHS = 'mx-maths--wide';

/** Maths nested in maths renders with its outermost expression. */
const outermost = (element: Element): boolean =>
  !element.parentElement?.closest('.mx-maths');

/**
 * Renders the maths of a sanitized message body with KaTeX (spec B). Nothing loads until a
 * rendered body holds `.mx-maths`; then {@link MathsLoader} fetches the KaTeX chunk and
 * stylesheet once (the sender's fallback shows until both have loaded), and each
 * expression is rendered from the LaTeX re-read in the sanitized string — parsed once per body,
 * paired with the live elements in document order. At most {@link MAX_MATHS_PER_MESSAGE}
 * render; the rest, and anything KaTeX rejects, show their source as code. Inline maths too
 * wide for the body is marked {@link WIDE_MATHS}, re-checked whenever the body resizes.
 */
@Directive({ selector: '[trnMaths]' })
export class MathsDirective {
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly loader = inject(MathsLoader);
  private resizes: ResizeObserver | null = null;

  readonly source = input('', { alias: 'trnMaths' });

  constructor() {
    afterRenderEffect(() => {
      const source = this.source();
      const render = this.loader.renderer();
      const live = [
        ...this.host.nativeElement.querySelectorAll('.mx-maths'),
      ].filter(outermost);
      if (live.length === 0) {
        return;
      }
      if (!render) {
        this.loader.load();
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
      this.fitInline();
      this.watchWidth();
    });
  }

  /** Re-check {@link fitInline} when the body's width changes; one observer per body. */
  private watchWidth(): void {
    if (this.resizes || typeof ResizeObserver === 'undefined') {
      return;
    }
    this.resizes = new ResizeObserver(() => this.fitInline());
    this.resizes.observe(this.host.nativeElement);
    this.destroyRef.onDestroy(() => this.resizes?.disconnect());
  }

  /**
   * Mark each outermost inline formula {@link WIDE_MATHS} when one of its runs is wider than
   * the body's content box. Reads every width before writing any class, so a body lays out
   * once however many formulas it holds.
   */
  private fitInline(): void {
    const host = this.host.nativeElement;
    const { paddingLeft, paddingRight } = getComputedStyle(host);
    const room =
      host.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight);
    const decided = [...host.querySelectorAll<HTMLElement>('span.mx-maths')]
      .filter(outermost)
      .map((maths) => {
        let widest = 0;
        for (const run of maths.querySelectorAll<HTMLElement>(
          '.katex-html > .katex-base',
        )) {
          widest = Math.max(widest, run.offsetWidth);
        }
        return [maths, room > 0 && widest > room] as const;
      });
    for (const [maths, wide] of decided) {
      maths.classList.toggle(WIDE_MATHS, wide);
    }
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
