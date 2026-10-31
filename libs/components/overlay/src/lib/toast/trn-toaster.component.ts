import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HlmToaster } from '@trinity/helm/sonner';

/**
 * The single app-root toast viewport, owned by Trinity's public overlay tier.
 * Toasts stay at the top: at the bottom they cover the composer, and its typed text.
 */
@Component({
  selector: 'trn-toaster',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmToaster],
  host: { class: 'contents', '(pointercancel)': 'endGesture($event)' },
  template: `<hlm-toaster position="top-center" [style]="toastStyle" />`,
})
export class TrnToasterComponent {
  /**
   * Sonner ends a gesture only on `pointerup`, but a browser that takes a drag over to scroll
   * sends `pointercancel`. Unended, the toast stays offset and every auto-dismiss timer stops.
   * The offset is cleared first: that drag was a scroll, and read as a swipe it dismisses the toast.
   */
  protected endGesture(event: PointerEvent): void {
    if (!(event.target instanceof Element)) {
      return;
    }
    event.target
      .closest<HTMLElement>('[data-sonner-toast]')
      ?.style.setProperty('--swipe-amount', '0px');
    event.target.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: event.pointerId,
      }),
    );
  }

  /** Keep Sonner's runtime-injected portal on Trinity's governed surface tokens. */
  protected readonly toastStyle = {
    '--normal-bg': 'var(--trinity-surface-raised)',
    '--normal-text': 'var(--trinity-text-bright)',
    '--normal-border': 'var(--trinity-border-subtle)',
    '--border-radius': 'var(--trinity-shape-overlay-radius)',
    '--brn-sonner-toast-close-button-background':
      'var(--trinity-surface-raised)',
    '--brn-sonner-toast-close-button-color': 'var(--trinity-text-bright)',
    '--brn-sonner-toast-close-button-border':
      '1px solid var(--trinity-border-subtle)',
    '--brn-sonner-toast-close-button-hover-background':
      'var(--trinity-surface-raised)',
    '--brn-sonner-toast-close-button-hover-color': 'var(--trinity-text-bright)',
    '--brn-sonner-toast-close-button-hover-border-color':
      'var(--trinity-border-subtle)',
    // Sonner's own stack leads with system-ui, which Linux fontconfig can resolve to a
    // serif face; use the stack the rest of the app inherits from Tailwind's preflight.
    '--brn-sonner-font-family': 'var(--default-font-family)',
  };
}
