import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  Observable,
  auditTime,
  distinctUntilChanged,
  map,
  merge,
  of,
} from 'rxjs';

/** A screen settles within a frame or two of a change; the status bar can trail it this much. */
const SETTLE_MS = 100;

/**
 * The colour at the top of the page as `#rrggbb`, and whether the page reaches under the status
 * bar there. It doesn't where the host pads the WebView below the bar (Android WebView before
 * 140) or where the browser draws its own (the web), so `env(safe-area-inset-top)` reads 0.
 */
export type StatusAreaReading =
  | {
      readonly kind: 'page';
      readonly color: string;
      readonly underStatusBar: boolean;
    }
  | { readonly kind: 'unknown' };

const UNKNOWN: StatusAreaReading = { kind: 'unknown' };

/** Cold host observation of what is painted under the status bar. */
export interface AppearanceStatusAreaSource {
  observe(): Observable<StatusAreaReading>;
}

/**
 * Reads what the page paints at the top centre of the viewport, the strip a phone's status bar
 * sits on, by compositing every element there. It samples at once, then again after DOM,
 * attribute or animation changes, so it follows screens, banners and overlays; an Appearance
 * change subscribes again. It runs only where the reading shows: on a touch screen (a phone's
 * status bar) or in an installed web app (its theme colour).
 */
@Injectable({ providedIn: 'root' })
export class BrowserAppearanceStatusAreaSource implements AppearanceStatusAreaSource {
  private readonly document = inject(DOCUMENT);
  private context: CanvasRenderingContext2D | null | undefined;
  private probe: HTMLElement | undefined;

  observe(): Observable<StatusAreaReading> {
    const view = this.document.defaultView;
    if (
      !view?.MutationObserver ||
      typeof view.matchMedia !== 'function' ||
      typeof this.document.elementsFromPoint !== 'function' ||
      !view.matchMedia('(pointer: coarse), (display-mode: standalone)').matches
    ) {
      return of(UNKNOWN);
    }
    const changes = new Observable<void>((subscriber) => {
      const changed = (): void => subscriber.next();
      const observer = new view.MutationObserver(changed);
      observer.observe(this.document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'class',
          'style',
          'hidden',
          'inert',
          'open',
          'data-pane-slide',
          'data-mobile-view',
          'data-forecast',
        ],
      });
      const events = ['animationend', 'resize'] as const;
      for (const type of events) view.addEventListener(type, changed, true);
      return () => {
        observer.disconnect();
        for (const type of events) {
          view.removeEventListener(type, changed, true);
        }
      };
    });
    return merge(of(undefined), changes.pipe(auditTime(SETTLE_MS))).pipe(
      map(() => this.sample(view)),
      distinctUntilChanged(sameReading),
    );
  }

  private sample(view: Window): StatusAreaReading {
    const context = this.canvas();
    if (!context) return UNKNOWN;
    const layers = this.document.elementsFromPoint(view.innerWidth / 2, 0);
    context.clearRect(0, 0, 1, 1);
    // shortcut: reads only each hit-testable element's background colour and, where it covers
    // the point, its top border; opacity, background images, pseudo-elements and
    // `pointer-events: none` layers are not seen. Upgrade if a top bar uses one of those.
    for (const element of layers.reverse()) {
      const style = view.getComputedStyle(element);
      this.paint(context, style.backgroundColor);
      const top = element.getBoundingClientRect().top;
      if (top <= 0 && top + Number.parseFloat(style.borderTopWidth) > 0) {
        this.paint(context, style.borderTopColor);
      }
    }
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (alpha !== 255) return UNKNOWN;
    const color = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    return { kind: 'page', color, underStatusBar: this.underStatusBar(view) };
  }

  private paint(context: CanvasRenderingContext2D, color: string): void {
    // An unparseable value leaves this in place instead of repainting the layer below.
    context.fillStyle = 'transparent';
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
  }

  private underStatusBar(view: Window): boolean {
    if (!this.probe) {
      this.probe = this.document.createElement('div');
      this.probe.setAttribute('aria-hidden', 'true');
      this.probe.style.cssText =
        'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px)';
      this.document.body.append(this.probe);
    }
    return Number.parseFloat(view.getComputedStyle(this.probe).paddingTop) > 0;
  }

  private canvas(): CanvasRenderingContext2D | null {
    if (this.context === undefined) {
      try {
        const canvas = this.document.createElement('canvas');
        canvas.width = canvas.height = 1;
        this.context = canvas.getContext('2d', { willReadFrequently: true });
      } catch {
        this.context = null;
      }
    }
    return this.context;
  }
}

function sameReading(
  left: StatusAreaReading,
  right: StatusAreaReading,
): boolean {
  return left.kind === 'page' && right.kind === 'page'
    ? left.color === right.color && left.underStatusBar === right.underStatusBar
    : left.kind === right.kind;
}

export const APPEARANCE_STATUS_AREA_SOURCE =
  new InjectionToken<AppearanceStatusAreaSource>(
    'APPEARANCE_STATUS_AREA_SOURCE',
    {
      providedIn: 'root',
      factory: () => inject(BrowserAppearanceStatusAreaSource),
    },
  );
