import { DOCUMENT, Injectable, inject } from '@angular/core';
import { EMPTY, Observable, defer, fromEvent, tap } from 'rxjs';
import { isNativeIos } from './mobile-os';

/**
 * iOS scrolls the WebView's own scroll view to the top on a status bar tap, but Trinity pins that
 * view (`scrollEnabled: false`) and scrolls inside its panes. Capacitor's status bar plugin
 * forwards the tap as a `statusTap` window event; this scrolls the pane in front to its top.
 *
 * The pane is the nearest scrollable ancestor of whatever sits at the centre of the topmost open
 * sheet or dialog, or of the screen when none is open, so the timeline, room list, settings pages
 * and threads need no wiring, and a sheet in front takes the tap instead of the page behind it.
 * A timeline stops at the oldest message it has loaded; its normal near-top paging then adds
 * older ones without moving the reader.
 */
@Injectable({ providedIn: 'root' })
export class NativeStatusBarTapAdapter {
  private readonly document = inject(DOCUMENT);

  run(): Observable<never> {
    return defer(() => {
      const view = this.document.defaultView;
      if (!isNativeIos() || !view) return EMPTY;
      return fromEvent(view, 'statusTap').pipe(
        tap(() => this.scrollFrontPaneToTop(view)),
      ) as Observable<never>;
    });
  }

  private scrollFrontPaneToTop(view: Window): void {
    // The topmost open sheet or dialog: a half-height sheet's top edge sits at the screen centre.
    const front = [
      ...this.document.querySelectorAll(
        '.cdk-overlay-container [role="dialog"]',
      ),
    ].at(-1);
    const box = front?.getBoundingClientRect();
    let el = box
      ? this.document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        )
      : this.document.elementFromPoint(
          view.innerWidth / 2,
          view.innerHeight / 2,
        );
    while (el) {
      if (el.scrollHeight > el.clientHeight && scrollsVertically(el, view)) {
        const reduceMotion = view.matchMedia(
          '(prefers-reduced-motion: reduce)',
        ).matches;
        el.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
        return;
      }
      el = el.parentElement;
    }
  }
}

function scrollsVertically(el: Element, view: Window): boolean {
  const { overflowY } = view.getComputedStyle(el);
  return overflowY === 'auto' || overflowY === 'scroll';
}
