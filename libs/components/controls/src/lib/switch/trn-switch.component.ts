import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import {
  trnSwitchRecipe,
  trnSwitchThumbRecipe,
} from '../choice-control/trn-choice-control-recipe';

/**
 * Trinity's switch: a preference that takes effect as you set it.
 *
 * A native checkbox with `role="switch"` owns keyboard, checked and disabled semantics. The
 * adjacent track and thumb are presentation only and consume the same bounded recipe vocabulary
 * as `trn-checkbox`.
 *
 * ## Why a second control rather than a flag on the first
 *
 * A checkbox and a switch are not a style choice. A checkbox is one of several answers you
 * submit together; a switch is a setting that applies the moment you touch it, and it says so
 * by looking like a physical one. Eleven of Trinity's fifteen checkboxes are settings —
 * appearance, privacy, notifications, the experimental flags — and each takes effect
 * immediately with nothing to submit. The other four are genuine multi-select: two room
 * pickers, the room-settings history options, and an acknowledgement you tick before
 * continuing. Those stay checkboxes, and that is why this is a new component rather than a
 * `variant` on the old one.
 *
 * ## The surface is the same four things
 *
 * `checked` in, `checkedChange` out, `disabled`, and accessible labelling for a switch with no
 * visible label of its own. Ordinal size changes only the recipe geometry; it does not alter
 * the native interaction model.
 *
 * The `ControlValueAccessor` is left unexposed for the reason `trn-checkbox` records: this
 * workspace uses Signal Forms only, and re-publishing a `@angular/forms` integration nobody
 * binds would tie the public API to it for nothing.
 *
 * Labelling is the caller's and already works — every call site wraps the control in its own
 * `<label>` carrying the text and the `data-testid`, which is why `aria-labelledby` has no
 * users here either.
 */
@Component({
  selector: 'trn-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    '@layer components { :host { position: relative; display: inline-flex; align-items: center; justify-content: center; min-width: var(--trinity-interaction-target-min-size); min-height: var(--trinity-interaction-target-min-size); } }',
  ],
  template: `
    <input
      class="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-default"
      type="checkbox"
      role="switch"
      [checked]="checked()"
      [attr.aria-checked]="checked()"
      [disabled]="disabled()"
      [attr.data-disabled]="disabled() ? 'true' : null"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-describedby]="ariaDescribedby()"
      (change)="onCheckedChange($event)"
    />
    <span
      aria-hidden="true"
      [class]="controlClass"
      [attr.data-checked]="checked()"
    >
      <span [class]="thumbClass()"></span>
    </span>
  `,
})
export class TrnSwitchComponent {
  private readonly injector = inject(Injector);
  protected readonly controlClass = trnSwitchRecipe();
  protected readonly thumbClass = computed(() =>
    trnSwitchThumbRecipe(this.checked()),
  );

  protected onCheckedChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    this.checkedChange.emit(input.checked);
    // Controlled: the native box already flipped, and re-binding an unchanged `checked`
    // would not undo that, so a parent that declines the change must see it revert.
    afterNextRender(() => (input.checked = this.checked()), {
      injector: this.injector,
    });
  }

  readonly checked = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });

  /** For a switch with no visible label of its own. */
  readonly ariaLabel = input<string | null>(null, { alias: 'aria-label' });
  /** Points at supporting text for the switch. */
  readonly ariaDescribedby = input<string | null>(null, {
    alias: 'aria-describedby',
  });

  readonly checkedChange = output<boolean>();
}
