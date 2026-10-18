import { Directive, output } from '@angular/core';
import {
  isMatrixLinkHref,
  parseMatrixLink,
  type MatrixLinkTarget,
} from '@trinity/util/matrix';

export type MatrixLinkClickTarget = MatrixLinkTarget | { kind: 'invalid' };

/**
 * A followed `matrix.to` link and the element it was followed from. The anchor lets a user
 * card appear BESIDE the mention instead of centred over the conversation. It is optional
 * because a permalink followed inside the edit-history dialog comes back after that dialog
 * has closed, so its anchor is gone.
 *
 * Declared here, not on `MatrixLinkTarget` in `@trinity/util/matrix`: that library is DI-free
 * and DOM-free, and a parsed permalink should not carry an `HTMLElement`.
 */
export interface MatrixLinkClick {
  readonly target: MatrixLinkClickTarget;
  readonly anchor?: HTMLElement;
}

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
  readonly matrixLink = output<MatrixLinkClick>();

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

    const target = parseMatrixLink(href);
    if (target) {
      event.preventDefault();
      this.matrixLink.emit({ target, anchor });
      return;
    }
    if (isMatrixLinkHref(href)) {
      event.preventDefault();
      this.matrixLink.emit({ target: { kind: 'invalid' }, anchor });
      return;
    }
    // An http(s) link to another origin leaves the app, however the href is spelled (`//host`,
    // `https:\\host`, `http:host`); same-origin and `#` links keep the browser's default.
    const http = /^https?:$/.test(anchor.protocol);
    const scheme = href.replace(/^[\u0000-\u0020]+|[\t\n\r]/g, '');
    // `javascript:` and `data:` never survive the sanitizer; refuse them here too, and an
    // http(s) href the URL parser rejects.
    if (
      http
        ? anchor.origin !== location.origin
        : /^(?:https?|javascript|data):/i.test(scheme)
    ) {
      event.preventDefault();
      if (http) window.open(anchor.href, '_blank', 'noopener,noreferrer');
    }
  }
}
