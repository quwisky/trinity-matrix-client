import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';

/** What a press lands on that can take focus back; the press target's nearest one wins. */
const CONTROL =
  'button, a[href], [role="button"], [role="menuitem"], [role="tab"], [tabindex]';

/**
 * Remembers the control that opened a dialog, so closing the dialog can hand focus back.
 *
 * CDK restores focus to whatever was focused when a dialog opened. Chrome focuses a button
 * as it is pressed, so that is the opener. WebKit never focuses a tapped button, so on iOS
 * it is whatever held focus before, and focus came back to the Settings container instead
 * of Security's Verify button (#1109).
 *
 * The last pressed control is the opener while focus has not moved since the press; any
 * later focus change, including the browser's own on press, leaves CDK's capture in charge.
 * Listening starts with `provideTrnOverlayDefaults()`, ahead of the first press.
 */
@Injectable({ providedIn: 'root' })
export class TrnDialogOpenerService {
  private readonly document = inject(DOCUMENT);
  private pressed: HTMLElement | null = null;

  // Capture phase: the control's own click handler may open the dialog within this press.
  private readonly onClick = (event: Event): void => {
    this.pressed =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(CONTROL)
        : null;
  };

  private readonly onFocusIn = (event: Event): void => {
    if (event.target !== this.pressed) this.pressed = null;
  };

  constructor() {
    this.document.addEventListener('click', this.onClick, true);
    this.document.addEventListener('focusin', this.onFocusIn, true);
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('click', this.onClick, true);
      this.document.removeEventListener('focusin', this.onFocusIn, true);
    });
  }

  /** CDK's `restoreFocus` for a dialog opening now: the pressed control, else CDK's own capture. */
  restoreTarget(): HTMLElement | true {
    const control = this.pressed;
    const focused = this.document.activeElement;
    return control?.isConnected && !control.contains(focused) ? control : true;
  }
}
