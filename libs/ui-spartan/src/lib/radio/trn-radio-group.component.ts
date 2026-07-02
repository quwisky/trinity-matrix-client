import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { ClassValue } from 'clsx';
import { hlm } from '../core/cn';

let groupId = 0;

/**
 * Radio group container. Child {@link TrnRadioComponent}s share the group's
 * `name` (so the browser gives single-selection + arrow-key roving focus for
 * free) and read/write the selected value through it. Bind `[value]` and listen
 * to `(valueChange)`; replaces `<ion-radio-group>`.
 */
@Component({
  selector: 'trn-radio-group',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'radiogroup',
    '[class]': '_computedClass()',
  },
  template: '<ng-content></ng-content>',
})
export class TrnRadioGroupComponent {
  readonly value = input<string | null>(null);
  readonly valueChange = output<string>();
  /** Shared radio `name`; auto-generated so multiple groups don't collide. */
  readonly name = input<string>(`trn-radio-group-${groupId++}`);
  readonly userClass = input<ClassValue>('', { alias: 'class' });

  protected readonly _computedClass = computed(() =>
    hlm('grid gap-3', this.userClass()),
  );

  /** Called by a child radio on selection; emits only on a real change. */
  select(value: string): void {
    if (value !== this.value()) {
      this.valueChange.emit(value);
    }
  }
}
