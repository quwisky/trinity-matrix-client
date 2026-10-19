import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import {
  trnRadioDescriptionRecipe,
  trnRadioGroupRecipe,
  trnRadioIndicatorDotRecipe,
  trnRadioIndicatorRecipe,
  trnRadioOptionRecipe,
  type TrnRadioGroupLayout,
} from './trn-radio-group-recipe';

export type { TrnRadioGroupLayout } from './trn-radio-group-recipe';

let nextRadioGroupId = 0;

/** One choice in a {@link TrnRadioGroupComponent}. */
export interface TrnRadioOption<T> {
  readonly value: T;
  /** The visible text, and the accessible name of the choice. */
  readonly label: string;
  /** Optional supporting text rendered inside the same native label. */
  readonly description?: string;
  /** Addresses this choice from a test. Every call site derives it from the value. */
  readonly testId?: string;
  /** Disables this choice alone; the group's `disabled` still disables every choice. */
  readonly disabled?: boolean;
}

/**
 * Trinity's radio group, driven by `[options]`.
 *
 * The `<label>` is rendered here, not by the caller: it keeps the click target label-sized
 * (the text is clickable, and e2e drives `getByTestId('mode-dark').click()` on the label, not
 * the radio). Native radio inputs own checked, disabled, focus and keyboard semantics; the
 * recipe owns only the visible indicator and option treatment.
 *
 * `aria-labelledby` is forwarded to the element that carries `role="radiogroup"` and removed
 * from this host, so the reference resolves against the thing it names.
 */
@Component({
  selector: 'trn-radio-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The caller's layout class lands on THIS host, so it must be a block. Without a display
  // the host is `inline`: padding lands on an inline box whose block-level grid child ignores
  // it, so options lose their indent and vertical padding spills into empty line boxes.
  // Storybook's real-browser control contract pins the host display; jsdom cannot evaluate
  // named cascade layers or layout.
  styles: ['@layer components { :host { display: block; } }'],
  host: {
    // Routed to the inner group below; a duplicate here would name an element with no role.
    '[attr.aria-label]': 'null',
    '[attr.aria-labelledby]': 'null',
    '[attr.data-layout]': 'layout()',
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
          [attr.data-disabled]="disabled() || option.disabled ? 'true' : null"
          [attr.data-testid]="option.testId"
        >
          <input
            class="peer sr-only"
            type="radio"
            role="radio"
            [name]="controlName"
            [checked]="option.value === value()"
            [disabled]="disabled() || !!option.disabled"
            [attr.aria-checked]="option.value === value()"
            [attr.aria-invalid]="invalid() ? 'true' : null"
            (change)="onValueChange(option.value)"
          />
          <span aria-hidden="true" [class]="indicatorClass()">
            <span [class]="indicatorDotClass(option.value === value())"></span>
          </span>
          <span class="flex min-w-0 flex-col items-start gap-0.5">
            <span>{{ option.label }}</span>
            @if (option.description) {
              <small [class]="descriptionClass">
                {{ option.description }}
              </small>
            }
          </span>
        </label>
      }
      <ng-content />
    </div>
  `,
})
export class TrnRadioGroupComponent<T> {
  readonly controlName = `trn-radio-${nextRadioGroupId++}`;
  protected readonly groupClass = computed(() =>
    trnRadioGroupRecipe(this.layout()),
  );
  protected readonly indicatorClass = computed(() =>
    trnRadioIndicatorRecipe(this.layout(), this.invalid()),
  );
  protected readonly descriptionClass = trnRadioDescriptionRecipe();

  protected optionClass(): string {
    return trnRadioOptionRecipe(this.layout());
  }

  protected indicatorDotClass(selected: boolean): string {
    return trnRadioIndicatorDotRecipe(selected);
  }

  /** Native change events always identify the concrete option that was chosen. */
  protected onValueChange(value: T): void {
    this.valueChange.emit(value);
  }

  readonly layout = input<TrnRadioGroupLayout>('list');
  /** Omit to project {@link TrnRadioComponent}s, each labelled by the caller's own row. */
  readonly options = input<readonly TrnRadioOption<T>[]>([]);
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

/**
 * One radio of a {@link TrnRadioGroupComponent} whose label the caller supplies, for a settings
 * row that names the choice. The radios share the group's native name, so the arrow keys move
 * between them. A native label for `inputId` operates it.
 */
@Component({
  selector: 'trn-radio',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    '@layer components { :host { position: relative; display: inline-flex; align-items: center; justify-content: center; min-width: var(--trinity-interaction-target-min-size); min-height: var(--trinity-interaction-target-min-size); } }',
  ],
  host: {
    '[attr.data-state]': 'selected() ? "selected" : "idle"',
    '[attr.data-disabled]': 'group.disabled() ? "true" : null',
  },
  template: `
    <input
      class="peer absolute inset-0 z-10 size-full cursor-pointer opacity-0 disabled:cursor-default"
      type="radio"
      role="radio"
      [attr.id]="inputId()"
      [name]="group.controlName"
      [checked]="selected()"
      [disabled]="group.disabled()"
      [attr.aria-checked]="selected()"
      [attr.aria-describedby]="ariaDescribedby()"
      (change)="group.valueChange.emit(value())"
    />
    <span aria-hidden="true" [class]="indicatorClass()">
      <span [class]="dotClass()"></span>
    </span>
  `,
})
export class TrnRadioComponent<T> {
  protected readonly group = inject<TrnRadioGroupComponent<T>>(
    TrnRadioGroupComponent,
  );
  protected readonly selected = computed(
    () => this.group.value() === this.value(),
  );
  protected readonly indicatorClass = computed(() =>
    trnRadioIndicatorRecipe('list', this.group.invalid()),
  );
  protected readonly dotClass = computed(() =>
    trnRadioIndicatorDotRecipe(this.selected()),
  );

  readonly value = input.required<T>();
  readonly inputId = input<string | null>(null);
  readonly ariaDescribedby = input<string | null>(null, {
    alias: 'aria-describedby',
  });
}
