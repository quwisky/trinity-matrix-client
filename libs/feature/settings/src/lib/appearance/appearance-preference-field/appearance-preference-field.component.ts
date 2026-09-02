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

export interface AppearancePreferenceField {
  readonly axis: AppearanceAxisKey;
  readonly headingId: string;
  readonly testId: string;
  readonly optionTestIdPrefix: string;
}

/** One descriptor-owned Appearance select with local command feedback and retry. */
@Component({
  selector: 'trn-appearance-preference-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appearance-preference-field.component.html',
  imports: [TrnButton, TrnSelectComponent, SettingsFieldRowDirective],
})
export class AppearancePreferenceFieldComponent {
  private readonly controller = inject(AppearanceSettingsController);

  protected readonly model = computed(
    () => this.controller.axes[this.field().axis],
  );
  protected readonly status = computed(
    () => this.controller.status[this.field().axis],
  );
  protected readonly options = computed<readonly TrnSelectOption<string>[]>(
    () =>
      this.model().editor.options.map((option) => ({
        ...option,
        testId: `${this.field().optionTestIdPrefix}-${option.value}`,
      })),
  );
  protected readonly hydrationBusy = this.controller.hydrationBusy;

  protected update(value: string | null | undefined): void {
    if (value !== null && value !== undefined) {
      this.controller.update(this.field().axis, value);
    }
  }

  protected retry(): void {
    this.controller.retry(this.field().axis);
  }

  readonly field = input.required<AppearancePreferenceField>();
}
