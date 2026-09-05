import { Injectable, signal } from '@angular/core';

/** Startup-safe surface state shared with the one Host Back owner. */
@Injectable({ providedIn: 'root' })
export class SystemStatusVisibilityService {
  private readonly opened = signal(false);
  private returnFocus: HTMLElement | null = null;
  readonly open = this.opened.asReadonly();

  show(): void {
    if (!this.opened()) {
      this.returnFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    this.opened.set(true);
  }

  close(): void {
    const returnFocus = this.returnFocus;
    this.returnFocus = null;
    this.opened.set(false);
    queueMicrotask(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
    });
  }
}
