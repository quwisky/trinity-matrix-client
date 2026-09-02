import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  output,
} from '@angular/core';
import {
  type TrnChoiceSize,
  type TrnChoiceVariant,
} from '../choice-control/trn-choice-control-recipe';
import {
  trnRadioGroupRecipe,
  trnRadioIndicatorDotRecipe,
  trnRadioIndicatorRecipe,
  trnRadioOptionRecipe,
  type TrnRadioGroupLayout,
} from './trn-radio-group-recipe';

export type TrnRadioGroupVariant = TrnChoiceVariant;
export type { TrnRadioGroupLayout } from './trn-radio-group-recipe';
export type TrnRadioGroupSize = TrnChoiceSize;

let nextRadioGroupId = 0;

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
 * radio). Native radio inputs now own checked, disabled, focus and keyboard semantics; the
 * recipe owns only the visible indicator and option treatment.
 *
 * `aria-labelledby` is forwarded to the element that actually carries `role="radiogroup"`
 * and removed from this host, so the reference resolves against the thing it names rather
 * than sitting on an outer element with no role.
 */
@Component({
  selector: 'trn-radio-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Wrapping moved the caller's layout class onto THIS host, so this host has to be a block.
  // The inner group is a grid, so a layout class moved onto this host has to keep block
  // geometry. Without a display the host falls back to `inline`: the padding lands
  // on an inline box whose block-level grid child ignores it, so the options lose their
  // indent and the vertical padding spills into empty line boxes instead of spacing them.
  // Measured in Chromium against the real class strings — first option x=16 -> x=0 and the
  // section 20px taller. Storybook's real-browser control contract pins the host display;
  // jsdom cannot evaluate named cascade layers or layout.
  styles: ['@layer components { :host { display: block; } }'],
  host: {
    // Routed to the inner group below; a duplicate here would name an element with no role.
    '[attr.aria-label]': 'null',
    '[attr.aria-labelledby]': 'null',
    '[attr.data-layout]': 'layout()',
    '[attr.data-size]': 'size()',
    '[attr.data-variant]': 'variant()',
    '[attr.data-invalid]': 'invalid() ? "true" : null',
  },
  template: `
    <div
      role="radiogroup"
      [class]="groupClass()"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-labelledby]="ariaLabelledby()"
      [attr.aria-invalid]="invalid() ? 'true' : null"
      [attr.data-invalid]="invalid() ? 'true' : null"
    >
      @for (option of options(); track option.value) {
        <label
          [class]="optionClass()"
          [attr.data-state]="option.value === value() ? 'selected' : 'idle'"
          [attr.data-disabled]="disabled() ? 'true' : null"
          [attr.data-testid]="option.testId"
        >
          <input
            class="peer sr-only"
            type="radio"
            role="radio"
            [name]="controlName"
            [checked]="option.value === value()"
            [disabled]="disabled()"
            [attr.aria-checked]="option.value === value()"
            [attr.aria-invalid]="invalid() ? 'true' : null"
            (change)="onValueChange(option.value)"
          />
          <span aria-hidden="true" [class]="indicatorClass()">
            <span [class]="indicatorDotClass(option.value === value())"></span>
          </span>
          {{ option.label }}
        </label>
      }
    </div>
  `,
})
export class TrnRadioGroupComponent<T> {
  protected readonly controlName = `trn-radio-${nextRadioGroupId++}`;
  protected readonly groupClass = computed(() =>
    trnRadioGroupRecipe(this.layout(), this.size()),
  );
  protected readonly indicatorClass = computed(() =>
    trnRadioIndicatorRecipe(this.layout(), this.size(), this.invalid()),
  );

  protected optionClass(): string {
    return trnRadioOptionRecipe(this.layout(), this.size(), this.variant());
  }

  protected indicatorDotClass(selected: boolean): string {
    return trnRadioIndicatorDotRecipe(selected, this.size(), this.variant());
  }

  /** Native change events always identify the concrete option that was chosen. */
  protected onValueChange(value: T): void {
    this.valueChange.emit(value);
  }

  /** Semantic tone. */
  readonly variant = input<TrnRadioGroupVariant>('neutral');
  readonly layout = input<TrnRadioGroupLayout>('list');
  readonly size = input<TrnChoiceSize>('md');
  readonly options = input.required<readonly TrnRadioOption<T>[]>();
  readonly value = input<T | null>(null);
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly invalid = input(false, { transform: booleanAttribute });

  /** Points at the heading that names the group. */
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });
  readonly ariaLabelledby = input<string | null>(null, {
    alias: 'aria-labelledby',
  });

  readonly valueChange = output<T>();
}
