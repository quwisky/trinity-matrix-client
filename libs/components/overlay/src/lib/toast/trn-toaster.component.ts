import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HlmToaster } from '@trinity/helm/sonner';

/** The single app-root toast viewport, owned by Trinity's public overlay tier. */
@Component({
  selector: 'trn-toaster',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmToaster],
  host: { class: 'contents' },
  template: `<hlm-toaster [style]="toastStyle" />`,
})
export class TrnToasterComponent {
  /** Keep Sonner's runtime-injected portal on Trinity's governed surface tokens. */
  protected readonly toastStyle = {
    '--normal-bg': 'var(--trinity-surface-raised)',
    '--normal-text': 'var(--trinity-text-bright)',
    '--normal-border': 'var(--trinity-border-subtle)',
    '--border-radius': 'var(--trinity-shape-overlay-radius)',
  };
}
