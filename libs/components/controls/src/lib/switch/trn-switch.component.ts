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
 * Trinity's switch: a setting that takes effect as you set it. A checkbox is one of several
 * answers submitted together; use a switch only for an immediate setting.
 *
 * A native checkbox with `role="switch"` owns keyboard, checked and disabled semantics; the
 * adjacent track and thumb are presentation only and share the recipe vocabulary of
 * `trn-checkbox`. No `ControlValueAccessor` (Signal Forms only). Labelling is the caller's
 * (wrap in a `<label>`).
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
      [attr.id]="inputId()"
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

  /** Id of the native control, so a `<label for>` elsewhere operates the switch. */
  readonly inputId = input<string | null>(null);
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
