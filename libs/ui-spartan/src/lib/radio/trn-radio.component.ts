import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  inject,
  input,
} from '@angular/core';
import type { ClassValue } from 'clsx';
import { hlm } from '../core/cn';
import { TrnRadioGroupComponent } from './trn-radio-group.component';

/**
 * A single radio option inside a {@link TrnRadioGroupComponent}. Renders a
 * visually-hidden native `<input type="radio">` (the `peer`) plus a styled
 * indicator whose `::after` dot appears on `:checked` — so selection, keyboard
 * navigation, and focus are the platform's. Projected content is the label.
 * Replaces `<ion-radio>`.
 */
@Component({
  selector: 'trn-radio',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': '_computedClass()',
  },
  template: `
    <label class="flex cursor-pointer items-center gap-3 text-sm font-medium">
      <input
        type="radio"
        class="peer sr-only"
        [name]="group.name()"
        [value]="value()"
        [checked]="group.value() === value()"
        [disabled]="disabled()"
        (change)="group.select(value())"
      />
      <span
        class="relative grid size-4 shrink-0 place-items-center rounded-full border border-solid border-primary after:absolute after:size-2 after:scale-0 after:rounded-full after:bg-primary after:transition-transform after:content-[''] peer-checked:after:scale-100 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:opacity-50"
      ></span>
      <ng-content></ng-content>
    </label>
  `,
})
export class TrnRadioComponent {
  protected readonly group = inject(TrnRadioGroupComponent);
  readonly value = input.required<string>();
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly userClass = input<ClassValue>('', { alias: 'class' });

  protected readonly _computedClass = computed(() =>
    hlm('block', this.userClass()),
  );
}
