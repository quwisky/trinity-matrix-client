import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import {
  HlmSelect,
  HlmSelectContent,
  HlmSelectItem,
  HlmSelectPortal,
  HlmSelectTrigger,
  HlmSelectValue,
} from '@trinity/helm/select';

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
 * Trinity's select.
 *
 * **This is the collapse the whole wrapper layer exists for.** The kit needs five cooperating
 * elements and a structural directive, and every one of the seven call sites wrote all of
 * them out:
 *
 * ```html
 * <hlm-select [value] [itemToString] (valueChange)>
 *   <hlm-select-trigger class="w-full">
 *     <hlm-select-value placeholder="Select a text size" />
 *   </hlm-select-trigger>
 *   <hlm-select-content *hlmSelectPortal>
 *     <hlm-select-item [value]="…">…</hlm-select-item>
 *   </hlm-select-content>
 * </hlm-select>
 * ```
 *
 * Nothing about that shape is Trinity's; it is the vendor's, repeated. No other library
 * composes a select that way, so it is exactly what a swap would have to rewrite at every
 * site. Now it is `[options]`.
 *
 * **`itemToString` is gone, not renamed.** All four call sites that bound it passed the same
 * function — find the option with this id, return its label — which a component that already
 * holds the options can do itself. Four hand-written lookups deleted rather than moved.
 *
 * **`triggerClass` is separate from `class`, and has to be.** Every call site put
 * `class="w-full"` on the TRIGGER and `class="block"` on the select; the kit's trigger is
 * `w-fit`, so folding them into one input would shrink every settings select to the width of
 * its text.
 *
 * **Known gap, deliberately not papered over:** `aria-labelledby` is left to land on this
 * host as a plain attribute, exactly where the call sites already put it — which means the
 * combobox is still not named. `role="combobox"` lives on a `<button>` inside the kit's
 * trigger, and the kit exposes no input reaching it, so naming it properly needs a
 * registered divergence in the vendored kit rather than a change here. Routing the
 * attribute to the inner `hlm-select` instead was tried and reverted: neither wrapper
 * carries a role, so it named nothing either way while splitting the attribute away from
 * the `data-testid` the same element carries. Parity, and the gap recorded.
 */
@Component({
  selector: 'trn-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Owned here rather than left to callers. Every one of the seven call sites wrote
  // `class="block"` because the kit's trigger is `w-fit`, so an inline host collapses the
  // control to its content width — which means the box model was a rule each consumer had
  // to know, and the first one to forget it would get a silently narrow select. Same
  // reasoning as TrnRadioGroupComponent, where forgetting it was already costing an indent.
  styles: [':host { display: block; }'],
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
      [itemToString]="labelFor"
      (valueChange)="onValueChange($event)"
    >
      <hlm-select-trigger [class]="triggerClass()">
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
export class TrnSelectComponent<T> {
  readonly options = input.required<readonly TrnSelectOption<T>[]>();
  readonly value = input<T | null>(null);

  /** Shown in the trigger until something is chosen. Every call site sets one. */
  readonly placeholder = input<string>('');

  /** Classes for the trigger, which is the element that carries the field's width. */
  readonly triggerClass = input<string>('');

  readonly valueChange = output<T>();

  /**
   * What the trigger shows for the chosen value.
   *
   * A bound arrow rather than a method so the reference stays stable across change
   * detection — the kit takes it as an input, and a new function identity every pass would
   * churn its own computed.
   */
  protected readonly labelFor = (value: T): string =>
    this.options().find((option) => option.value === value)?.label ??
    String(value ?? '');

  /**
   * The kit emits `T | null | undefined` — three states, because brain distinguishes "no
   * value" from "not yet initialised". A chosen option is never either, so the public output
   * promises `T` and the empty cases are dropped here rather than pushed to every call site.
   * Caught by the AOT build; `nx typecheck` does not check templates.
   */
  protected onValueChange(value: T | null | undefined): void {
    if (value !== null && value !== undefined) {
      this.valueChange.emit(value);
    }
  }
}
