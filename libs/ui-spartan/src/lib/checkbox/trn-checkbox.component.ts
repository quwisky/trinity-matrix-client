import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  output,
} from '@angular/core';
import type { ClassValue } from 'clsx';
import { hlm } from '../core/cn';

/**
 * Checkbox (shadcn/spartan "helm"). A visually-hidden native
 * `<input type="checkbox">` (the `peer`) drives a styled box whose `::after`
 * checkmark appears on `:checked` — so toggling, focus, and a11y are the
 * platform's. Bind `[checked]` and listen to `(checkedChange)`; projected
 * content is the label. Replaces `<ion-checkbox>`.
 */
@Component({
  selector: 'trn-checkbox',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': '_computedClass()',
  },
  template: `
    <label class="flex cursor-pointer items-center gap-2 text-sm font-medium">
      <input
        type="checkbox"
        class="peer sr-only"
        [checked]="checked()"
        [disabled]="disabled()"
        (change)="onToggle($event)"
      />
      <span
        class="grid size-4 shrink-0 place-items-center rounded-sm border border-solid border-primary transition-colors after:h-[9px] after:w-[5px] after:-translate-y-px after:rotate-45 after:scale-0 after:border-b-2 after:border-r-2 after:border-solid after:border-primary-foreground after:transition-transform after:content-[''] peer-checked:border-primary peer-checked:bg-primary peer-checked:after:scale-100 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-disabled:opacity-50"
      ></span>
      <ng-content></ng-content>
    </label>
  `,
})
export class TrnCheckboxComponent {
  readonly checked = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly checkedChange = output<boolean>();
  readonly userClass = input<ClassValue>('', { alias: 'class' });

  protected readonly _computedClass = computed(() =>
    hlm('block', this.userClass()),
  );

  protected onToggle(event: Event): void {
    this.checkedChange.emit((event.target as HTMLInputElement).checked);
  }
}
