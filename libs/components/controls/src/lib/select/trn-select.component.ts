import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
} from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import {
  HlmSelect,
  HlmSelectContent,
  HlmSelectItem,
  HlmSelectPortal,
  HlmSelectTrigger,
  HlmSelectValue,
} from '@trinity/helm/select';
import {
  trnSelectHelmSize,
  trnSelectTriggerRecipe,
  type TrnSelectSize,
} from './trn-select-recipe';

export type { TrnSelectSize } from './trn-select-recipe';

/** One choice in a {@link TrnSelectComponent}. */
export interface TrnSelectOption<T> {
  readonly value: T;
  /** The option's text — and the trigger's, once it is chosen. */
  readonly label: string;
  /** A second, quieter line under the label. Only the space-order select uses one. */
  readonly description?: string;
  /** Addresses this option from a test. Every call site derives it from the value. */
  readonly testId?: string;
  readonly disabled?: boolean;
}

/**
 * Trinity's select, driven by `[options]` so call sites don't compose the kit's five elements
 * and structural directive. The trigger fills the host (the kit's is `w-fit`); a consumer
 * `class` remains available for surrounding layout.
 *
 * `aria-labelledby` is routed to the actual combobox button through Trinity's registered
 * `HlmSelectTrigger` divergence. The host keeps the consumer's `data-testid` but is stripped
 * of the naming attribute because it carries no interactive role.
 */
@Component({
  selector: 'trn-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The host owns its outer display; the private trigger recipe owns the full-width inner class.
  host: {
    class: 'block',
    '[attr.aria-labelledby]': 'null',
    '[attr.data-size]': 'size()',
    '[attr.data-invalid]': 'invalid() ? "true" : null',
  },
  imports: [
    HlmSelect,
    HlmSelectTrigger,
    HlmSelectValue,
    HlmSelectContent,
    HlmSelectItem,
    HlmSelectPortal,
  ],
  template: `
    <hlm-select
      [value]="value()"
      [disabled]="disabled()"
      [itemToString]="labelFor"
      (valueChange)="onValueChange($event)"
    >
      <hlm-select-trigger
        [class]="triggerClass"
        [size]="helmSize()"
        [forceInvalid]="invalid()"
        [aria-labelledby]="ariaLabelledby()"
      >
        <hlm-select-value [placeholder]="placeholder()" />
      </hlm-select-trigger>
      <hlm-select-content *hlmSelectPortal>
        @for (option of options(); track option.value) {
          <hlm-select-item
            [value]="option.value"
            [disabled]="option.disabled ?? false"
            [attr.data-testid]="option.testId"
          >
            @if (option.description) {
              <!--
                A div, not a span: hlm-select-item forces "flex items-center gap-2" onto
                its last direct span child, which would lay these two lines out side by
                side. Carried over from the call site that discovered it — backticks are
                avoided here on purpose, since this comment lives inside a template literal.
              -->
              <div class="flex flex-col items-start gap-0.5">
                <span>{{ option.label }}</span>
                <span class="text-xs text-muted-foreground">{{
                  option.description
                }}</span>
              </div>
            } @else {
              {{ option.label }}
            }
          </hlm-select-item>
        }
      </hlm-select-content>
    </hlm-select>
  `,
})
export class TrnSelectComponent<T> implements FormValueControl<T | null> {
  readonly ariaLabelledby = input<string | null>(null, {
    alias: 'aria-labelledby',
  });
  readonly options = input.required<readonly TrnSelectOption<T>[]>();

  /**
   * A `model`, not an `input`: Signal Forms' `FormValueControl` contract requires a `model()`
   * kept in sync with the bound field, which is what makes `[formField]` work here. It
   * publishes the same `[value]` input and `valueChange` output as an `input` + `output` pair.
   */
  readonly value = model<T | null>(null);

  /**
   * Taken from the schema when bound through `[formField]`, so `disabled(path, { when })`
   * reaches the control; without it a gated field would render enabled.
   */
  readonly disabled = input<boolean>(false);

  /** Ordinal sizes implemented by the current select trigger. */
  readonly size = input<TrnSelectSize>('md');

  /** Explicit validation state, independent from semantic treatment. */
  readonly invalid = input(false, { transform: booleanAttribute });

  /** Shown in the trigger until something is chosen. Every call site sets one. */
  readonly placeholder = input<string>('');

  /** Private vendor adapter; neither `default` nor the trigger class is public API. */
  protected readonly helmSize = computed(() => trnSelectHelmSize(this.size()));
  protected readonly triggerClass = trnSelectTriggerRecipe();

  /**
   * What the trigger shows for the chosen value. A bound arrow, not a method: the kit takes it
   * as an input, and a new function identity every pass would churn its computed.
   */
  protected readonly labelFor = (value: T): string =>
    this.options().find((option) => option.value === value)?.label ??
    String(value ?? '');

  /**
   * The kit emits `T | null | undefined` because brain distinguishes "no value" from "not yet
   * initialised". A chosen option is neither, so the empty cases are dropped here and
   * `valueChange` only fires with a real choice. The AOT build checks this; `nx typecheck`
   * does not check templates.
   */
  protected onValueChange(value: T | null | undefined): void {
    if (value !== null && value !== undefined) {
      this.value.set(value);
    }
  }
}
