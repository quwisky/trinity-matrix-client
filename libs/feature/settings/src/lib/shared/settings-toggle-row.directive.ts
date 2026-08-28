import { Directive, input } from '@angular/core';

/**
 * A styling primitive applied to the existing native label. It adds no wrapper and therefore
 * preserves the switch's click target and accessible name while sharing the density recipe.
 */
@Directive({
  selector: '[trnSettingsToggleRow]',
  host: {
    class:
      'mx-4 flex cursor-pointer items-start gap-[var(--trinity-density-row-gap)] rounded-[var(--trinity-shape-control-radius)] px-[var(--trinity-density-row-padding-inline)] py-[var(--trinity-density-row-padding-block)] text-[length:var(--trinity-type-control-size)] leading-[var(--trinity-type-control-line-height)] font-[var(--trinity-type-control-weight)] hover:bg-[var(--trinity-state-hover-surface)]',
    style:
      'min-height: max(var(--trinity-density-control-size), var(--trinity-interaction-target-min-size))',
    '[style.margin-inline-start]':
      "nested() ? 'calc(var(--trinity-space-4) + var(--trinity-space-4))' : null",
  },
})
export class SettingsToggleRowDirective {
  /** Indent a dependent preference without changing the native label/switch structure. */
  readonly nested = input(false);
}
