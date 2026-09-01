import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import {
  TrnButton,
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/controls';
import { SettingsFieldRowDirective } from '../../shared/settings-field-row.directive';
import {
  AppearanceSettingsController,
  type AppearanceAxisKey,
} from '../appearance-settings.controller';

/** One descriptor-owned Appearance select with local command feedback and retry. */
@Component({
  selector: 'trn-appearance-preference-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appearance-preference-field.component.html',
  imports: [TrnButton, TrnSelectComponent, SettingsFieldRowDirective],
})
export class AppearancePreferenceFieldComponent {
  protected readonly controller = inject(AppearanceSettingsController);

  readonly axis = input.required<AppearanceAxisKey>();
  readonly headingId = input.required<string>();
  readonly testId = input.required<string>();
  readonly optionTestIdPrefix = input.required<string>();

  protected readonly model = computed(() => this.controller.axes[this.axis()]);
  protected readonly status = computed(
    () => this.controller.status[this.axis()],
  );
  protected readonly options = computed<readonly TrnSelectOption<string>[]>(
    () =>
      this.model().editor.options.map((option) => ({
        ...option,
        testId: `${this.optionTestIdPrefix()}-${option.value}`,
      })),
  );

  protected update(value: string | null | undefined): void {
    if (value !== null && value !== undefined) {
      this.controller.update(this.axis(), value);
    }
  }
}
