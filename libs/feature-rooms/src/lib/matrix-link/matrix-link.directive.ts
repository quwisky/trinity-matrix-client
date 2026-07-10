import { Directive, output } from '@angular/core';
import { parseMatrixToLink, type MatrixLinkTarget } from '@trinity/util-matrix';

/**
 * Intercepts anchor clicks inside a rendered message body (set via `[innerHTML]`, so
 * the links have no Angular bindings of their own):
 * - a `matrix.to` permalink is routed in-app — the click is swallowed and its parsed
 *   {@link MatrixLinkTarget} is emitted for the host to navigate to;
 * - any other `http(s)` link opens in a new tab with `noopener` rather than replacing
 *   the app (which would blow away a PWA/desktop session).
 *
 * A click inside a concealed spoiler is left to {@link SpoilerRevealDirective} (the
 * first click reveals, it doesn't follow the link).
 */
@Directive({
  selector: '[trnMatrixLink]',
  host: { '(click)': 'onClick($event)' },
})
export class MatrixLinkDirective {
  readonly matrixLink = output<MatrixLinkTarget>();

  onClick(event: Event): void {
    const anchor = (event.target as HTMLElement | null)?.closest('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href) {
      return;
    }
    // Let the spoiler directive handle a link still hidden behind a spoiler.
    if (anchor.closest('.mx-spoiler:not(.is-revealed)')) {
      return;
    }

    const target = parseMatrixToLink(href);
    if (target) {
      event.preventDefault();
      this.matrixLink.emit(target);
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      // Open external links out-of-app so a navigation can't discard the session.
      event.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  }
}
