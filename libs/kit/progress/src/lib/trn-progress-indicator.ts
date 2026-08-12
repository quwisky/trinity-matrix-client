import { Directionality } from '@angular/cdk/bidi';
import { Directive, computed, inject } from '@angular/core';
import {
  BrnProgressIndicator,
  injectBrnProgress,
} from '@spartan-ng/brain/progress';
import { classes } from '@trinity/kit/utils';

/**
 * ┌─ VENDORED FILE — @spartan-ng/cli generated, then diverged ────────────────────────────┐
 *
 * One deliberate local override: every `hostDirectives` entry states its `inputs` and
 * `outputs` explicitly, even when both are empty. `hostDirectives` is public API — a
 * composed directive's input or output is bindable on our element only if the entry lists
 * it — so the generator's shorthand form makes that decision by omission. It hid a real
 * defect once: `TrnInput` composed `BrnFieldControlDescribedBy` without listing
 * `aria-describedby`, so the attribute was silently overwritten with null (#153).
 *
 * A regenerate drops this and restores the shorthand. `scripts/host-directives.spec.mjs`
 * fails when it does, rather than letting it ship. See "Registered vendored divergences"
 * in docs/architecture/ui-and-theming.md.
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 */

@Directive({
  selector: '[trnProgressIndicator],trn-progress-indicator',
  hostDirectives: [
    { directive: BrnProgressIndicator, inputs: [], outputs: [] },
  ],
  host: {
    'data-slot': 'progress-indicator',
    '[class.animate-indeterminate]': '_indeterminate()',
    '[style.transform]': '_transform()',
  },
})
export class TrnProgressIndicator {
  private readonly _progress = injectBrnProgress();
  private readonly _dir = inject(Directionality);
  // Offset the indicator by the unfilled remainder. In RTL the bar fills from the inline-start
  // (visually the right), so translate the opposite way to keep the fill on the correct side.
  protected readonly _transform = computed(() => {
    const offset = 100 - (this._progress.value() ?? 100);
    return `translateX(${this._dir.valueSignal() === 'rtl' ? '' : '-'}${offset}%)`;
  });
  protected readonly _indeterminate = computed(
    () =>
      this._progress.value() === null || this._progress.value() === undefined,
  );

  constructor() {
    classes(() => 'bg-primary h-full w-full flex-1 transition-all');
  }
}
