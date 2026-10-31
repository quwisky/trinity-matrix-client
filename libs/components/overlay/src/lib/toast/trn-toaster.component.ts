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
  host: { class: 'contents' },
  template: `<hlm-toaster position="top-center" [style]="toastStyle" />`,
})
export class TrnToasterComponent {
  /** Keep Sonner's runtime-injected portal on Trinity's governed surface tokens. */
  protected readonly toastStyle = {
    '--normal-bg': 'var(--trinity-surface-raised)',
    '--normal-text': 'var(--trinity-text-bright)',
    '--normal-border': 'var(--trinity-border-subtle)',
    '--border-radius': 'var(--trinity-shape-overlay-radius)',
    // Sonner's own stack leads with system-ui, which Linux fontconfig can resolve to a
    // serif face; use the stack the rest of the app inherits from Tailwind's preflight.
    '--brn-sonner-font-family': 'var(--default-font-family)',
  };
}
