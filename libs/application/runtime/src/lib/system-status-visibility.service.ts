import { Injectable, signal } from '@angular/core';

/** Startup-safe surface state shared with the one Host Back owner. */
@Injectable({ providedIn: 'root' })
export class SystemStatusVisibilityService {
  private readonly opened = signal(false);
  private backHandler: (() => void) | null = null;
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

  /** The rendered view handles section Back through the existing Host Back owner. */
  registerBackHandler(handler: () => void): () => void {
    this.backHandler = handler;
    return () => {
      if (this.backHandler === handler) this.backHandler = null;
    };
  }

  back(): void {
    if (this.backHandler) this.backHandler();
    else this.close();
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
