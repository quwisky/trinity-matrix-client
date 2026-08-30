import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmProgress, HlmProgressIndicator } from '@trinity/helm/progress';

/**
 * Trinity's progress bar.
 *
 * **The composition is collapsed on purpose.** The kit needs two elements — a host and an
 * indicator child that injects the host through DI and fails outside it — so every call site
 * has to know that the child exists and that it goes exactly there. That knowledge is the
 * vendor's, not ours, and it is exactly the kind of shape that does not survive swapping the
 * library. One element, one input:
 *
 * ```html
 * <trn-progress [value]="fraction() * 100" aria-label="Uploading attachment" />
 * ```
 *
 * `null` means indeterminate, which is the kit's own convention and the one the single call
 * site relies on while an upload has no measurable total.
 *
 * `max` and `getValueLabel` are not exposed: nothing passes them, and the default of 100
 * matches how the value is computed at the only call site.
 */
@Component({
  selector: 'trn-progress',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmProgress, HlmProgressIndicator],
  styles: [':host { display: block; }'],
  template: `
    <hlm-progress [value]="value()" [attr.aria-label]="ariaLabel()">
      <div hlmProgressIndicator></div>
    </hlm-progress>
  `,
})
export class TrnProgressComponent {
  /** Percentage complete, or `null` for an indeterminate bar. */
  readonly value = input<number | null>(null);

  /** What is progressing — announced by screen readers. */
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });
}
