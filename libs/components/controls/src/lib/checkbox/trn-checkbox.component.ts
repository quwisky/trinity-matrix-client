import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  output,
} from '@angular/core';
import {
  trnCheckboxRecipe,
  type TrnChoiceSize,
  type TrnChoiceVariant,
} from '../choice-control/trn-choice-control-recipe';

export type TrnCheckboxSize = TrnChoiceSize;
export type TrnCheckboxVariant = TrnChoiceVariant;

/**
 * Trinity's checkbox.
 *
 * A native checkbox remains the semantic and focusable control. The adjacent recipe span is
 * presentation only, so checked, indeterminate, disabled and invalid state are reported on the
 * element assistive technology and browser automation actually operate.
 *
 * The `ControlValueAccessor` in particular is deliberately not re-exposed: this workspace
 * uses Signal Forms only, no call site binds a checkbox to a form control, and re-publishing
 * a forms integration nobody uses would tie the public API to `@angular/forms` for nothing.
 *
 * Labelling is the caller's, and already works: every call site wraps the checkbox in its
 * own `<label>` carrying the text and the `data-testid`. `aria-label` is forwarded for the one
 * place that has no visible text, and `aria-describedby` connects validation help.
 */
@Component({
  selector: 'trn-checkbox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    ':host { position: relative; display: inline-flex; align-items: center; justify-content: center; min-width: var(--trinity-interaction-target-min-size); min-height: var(--trinity-interaction-target-min-size); }',
  ],
  host: {
    '[attr.data-size]': 'size()',
    '[attr.data-variant]': 'variant()',
    '[attr.data-invalid]': 'invalid() ? "true" : null',
  },
  template: `
    <input
      class="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-default"
      type="checkbox"
      role="checkbox"
      [checked]="checked()"
      [attr.aria-checked]="indeterminate() ? 'mixed' : checked()"
      [indeterminate]="indeterminate()"
      [disabled]="disabled()"
      [attr.aria-invalid]="invalid() ? 'true' : null"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-describedby]="ariaDescribedby()"
      (change)="onCheckedChange($event)"
    />
    <span
      aria-hidden="true"
      [class]="controlClass()"
      [attr.data-checked]="checked() || indeterminate() ? '' : null"
      [attr.data-invalid]="invalid() ? 'true' : null"
    >
      @if (indeterminate()) {
        −
      } @else if (checked()) {
        ✓
      }
    </span>
  `,
})
export class TrnCheckboxComponent {
  protected readonly controlClass = computed(() =>
    trnCheckboxRecipe(this.variant(), this.size()),
  );

  protected onCheckedChange(event: Event): void {
    const control = event.currentTarget as HTMLInputElement;
    this.checkedChange.emit(control.checked);
    if (!control.indeterminate && this.indeterminate()) {
      this.indeterminateChange.emit(false);
    }
  }

  readonly checked = input(false, { transform: booleanAttribute });
  readonly indeterminate = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly invalid = input(false, { transform: booleanAttribute });
  readonly variant = input<TrnChoiceVariant>('accent');
  readonly size = input<TrnChoiceSize>('md');

  /** For a checkbox with no visible label of its own. */
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });
  /** Points at help or validation text for the checkbox. */
  readonly ariaDescribedby = input<string | null>(null, {
    alias: 'aria-describedby',
  });

  readonly checkedChange = output<boolean>();
  readonly indeterminateChange = output<boolean>();
}
