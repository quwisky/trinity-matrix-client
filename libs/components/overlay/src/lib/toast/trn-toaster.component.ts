import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HlmToaster } from '@trinity/helm/sonner';

/** The single app-root toast viewport, owned by Trinity's public overlay tier. */
@Component({
  selector: 'trn-toaster',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmToaster],
  host: { class: 'contents' },
  template: `<hlm-toaster />`,
})
export class TrnToasterComponent {}
