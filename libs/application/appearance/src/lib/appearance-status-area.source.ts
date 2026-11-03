import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, auditTime, distinctUntilChanged, map, of } from 'rxjs';

/** A screen settles within a frame or two of a change; the status bar can trail it this much. */
const SETTLE_MS = 100;

/** Cold host observation of the colour painted under the status bar, as `#rrggbb`. */
export interface AppearanceStatusAreaSource {
  observe(): Observable<string | null>;
}

/**
 * Reads what the page paints at the top centre of the viewport, the strip a phone's status bar
 * sits on, by compositing the backgrounds of every element there. It samples again after DOM,
 * class or animation changes, so it follows screens, banners and overlays; an Appearance change
 * subscribes again.
 * Null where the engine cannot hit-test or read back a canvas.
 */
@Injectable({ providedIn: 'root' })
export class BrowserAppearanceStatusAreaSource implements AppearanceStatusAreaSource {
  private readonly document = inject(DOCUMENT);
  private context: CanvasRenderingContext2D | null | undefined;

  observe(): Observable<string | null> {
    const view = this.document.defaultView;
    if (
      !view?.MutationObserver ||
      typeof this.document.elementsFromPoint !== 'function'
    ) {
      return of(null);
    }
    return new Observable<void>((subscriber) => {
      const changed = (): void => subscriber.next();
      const observer = new view.MutationObserver(changed);
      observer.observe(this.document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'inert', 'data-pane-slide'],
      });
      const events = ['animationend', 'resize'] as const;
      for (const type of events) view.addEventListener(type, changed, true);
      changed();
      return () => {
        observer.disconnect();
        for (const type of events)
          view.removeEventListener(type, changed, true);
      };
    }).pipe(
      auditTime(SETTLE_MS),
      map(() => this.sample(view)),
      distinctUntilChanged(),
    );
  }

  private sample(view: Window): string | null {
    const context = this.canvas();
    if (!context) return null;
    const layers = this.document.elementsFromPoint(view.innerWidth / 2, 0);
    context.clearRect(0, 0, 1, 1);
    for (const element of layers.reverse()) {
      // An unparseable value leaves this in place instead of repainting the layer below.
      context.fillStyle = 'transparent';
      context.fillStyle = view.getComputedStyle(element).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
    if (alpha !== 255) return null;
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
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

export const APPEARANCE_STATUS_AREA_SOURCE =
  new InjectionToken<AppearanceStatusAreaSource>(
    'APPEARANCE_STATUS_AREA_SOURCE',
    {
      providedIn: 'root',
      factory: () => inject(BrowserAppearanceStatusAreaSource),
    },
  );
