import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import {
  HlmRadio,
  HlmRadioGroup,
  HlmRadioIndicator,
} from '@trinity/helm/radio-group';

export type TrnRadioGroupVariant = 'list' | 'segmented';

/** One choice in a {@link TrnRadioGroupComponent}. */
export interface TrnRadioOption<T> {
  readonly value: T;
  /** The visible text, and the accessible name of the choice. */
  readonly label: string;
  /** Addresses this choice from a test. Every call site derives it from the value. */
  readonly testId?: string;
}

/**
 * Trinity's radio group.
 *
 * **The composition is collapsed, and the `<label>` comes with it.** All three call sites
 * wrote the same three levels by hand — a group, a `<label>` carrying the click target, the
 * text and the `data-testid`, and inside it a radio wrapping a mandatory indicator element:
 *
 * ```html
 * <hlm-radio-group [value] (valueChange)>
 *   <label class="flex cursor-pointer items-center gap-3 …" data-testid="mode-dark">
 *     <hlm-radio value="dark"><hlm-radio-indicator /></hlm-radio>
 *     Dark
 *   </label>
 * </hlm-radio-group>
 * ```
 *
 * That is four pieces of vendor structure at every call site, one of which — the indicator —
 * renders nothing at all if forgotten. Now it is `[options]`.
 *
 * **The label is rendered here rather than left to the caller, and that is load-bearing in
 * two ways.** It keeps the click target label-sized, which is what makes the text clickable
 * and what e2e drives (`getByTestId('mode-dark').click()` addresses the label, not the
 * radio). And the kit's radio resolves `closest('label')` in a constructor effect to stamp
 * its disabled state — a wrapper that stopped emitting a wrapping label would leave that
 * silently doing nothing.
 *
 * `aria-labelledby` is forwarded to the element that actually carries `role="radiogroup"`
 * and removed from this host, so the reference resolves against the thing it names rather
 * than sitting on an outer element with no role.
 */
@Component({
  selector: 'trn-radio-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmRadioGroup, HlmRadio, HlmRadioIndicator],
  // Wrapping moved the caller's layout class onto THIS host, so this host has to be a block.
  // The kit's `hlm-radio-group` merges `grid gap-2` into its own class list, so on the
  // element this replaced a `class="px-4 py-2"` applied to a grid box. Here that class sits
  // one level out, and without a display the host falls back to `inline`: the padding lands
  // on an inline box whose block-level grid child ignores it, so the options lose their
  // indent and the vertical padding spills into empty line boxes instead of spacing them.
  // Measured in Chromium against the real class strings — first option x=16 -> x=0 and the
  // section 20px taller — which no test in this repo can see, since jsdom does no layout.
  // A component STYLE rather than a Tailwind class so the spec below can assert it.
  styles: [
    `
      :host {
        display: block;
      }

      :host([data-variant='segmented']) hlm-radio-group {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: minmax(0, 1fr);
        gap: var(--trinity-space-1);
        padding: var(--trinity-space-1);
        border: 1px solid var(--trinity-border-subtle);
        border-radius: var(--trinity-shape-control-radius);
        background: var(--trinity-surface-floating);
      }

      :host([data-variant='segmented']) label {
        min-height: max(
          var(--trinity-density-control-size),
          var(--trinity-interaction-target-min-size)
        );
        justify-content: center;
        padding-inline: var(--trinity-space-3);
        border-radius: calc(var(--trinity-shape-control-radius) - 2px);
        color: var(--trinity-text-muted);
        transition:
          background-color var(--trinity-duration-fast)
            var(--trinity-ease-standard),
          color var(--trinity-duration-fast) var(--trinity-ease-standard),
          box-shadow var(--trinity-duration-fast) var(--trinity-ease-standard);
        text-align: center;
        overflow-wrap: anywhere;
      }

      :host([data-variant='segmented']) label:hover {
        background: var(--trinity-state-hover-surface);
        color: var(--trinity-state-hover-foreground);
      }

      :host([data-variant='segmented']) label.trn-radio-option--selected {
        background: var(--trinity-state-selected-surface);
        color: var(--trinity-state-selected-foreground);
        box-shadow: var(--trinity-shadow-raised);
      }

      :host([data-variant='segmented']) label:has(input:focus-visible) {
        outline: var(--trinity-focus-ring-width) solid var(--trinity-focus-ring);
        outline-offset: var(--trinity-focus-ring-offset);
      }

      :host([data-variant='segmented']) hlm-radio-indicator {
        display: none;
      }
    `,
  ],
  host: {
    // Routed to the inner group below; a duplicate here would name an element with no role.
    '[attr.aria-labelledby]': 'null',
    '[attr.data-variant]': 'variant()',
  },
  template: `
    <hlm-radio-group
      [value]="value()"
      [disabled]="disabled()"
      (valueChange)="onValueChange($event)"
      [attr.aria-labelledby]="ariaLabelledby()"
    >
      @for (option of options(); track option.value) {
        <label
          class="flex cursor-pointer items-center gap-3 text-sm font-medium"
          [class.trn-radio-option--selected]="option.value === value()"
          [attr.data-testid]="option.testId"
        >
          <hlm-radio [value]="option.value" [disabled]="disabled()">
            <hlm-radio-indicator />
          </hlm-radio>
          {{ option.label }}
        </label>
      }
    </hlm-radio-group>
  `,
})
export class TrnRadioGroupComponent<T> {
  readonly variant = input<TrnRadioGroupVariant>('list');
  readonly options = input.required<readonly TrnRadioOption<T>[]>();
  readonly value = input<T | null>(null);
  readonly disabled = input(false);

  /** Points at the heading that names the group. */
  readonly ariaLabelledby = input<string | null>(null, {
    alias: 'aria-labelledby',
  });

  readonly valueChange = output<T>();

  /**
   * The kit's group emits `T | null`, because brain models "nothing selected yet" as a
   * value. A radio group that has been *chosen* from never emits that, so the public output
   * promises `T` and this drops the empty case rather than pushing a null every call site
   * would have to re-check. Caught by the AOT build, which type-checks templates where
   * `nx typecheck` does not.
   */
  protected onValueChange(value: T | null): void {
    if (value !== null) {
      this.valueChange.emit(value);
    }
  }
}
