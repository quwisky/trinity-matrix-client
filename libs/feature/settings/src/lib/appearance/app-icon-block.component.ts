import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnButton,
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/controls';
import { TrnAlertService } from '@trinity/components/overlay';
import { appIconHost, type AppIconHost } from '@trinity/platform-native';
import { SettingsFieldRowDirective } from '../shared/settings-field-row.directive';
import { AppearanceSettingsController } from './appearance-settings.controller';

const ANDROID_WARNING =
  'Changing the icon may close Trinity and remove pinned shortcuts on some launchers.';

const HELP: Readonly<Record<AppIconHost, string>> = {
  ios: 'iOS confirms the change with a system alert.',
  android: ANDROID_WARNING,
  desktop: 'Changes the Dock / taskbar icon while Trinity is running.',
  web: 'Changes the browser tab icon.',
};

/**
 * The App icon choice. Android offers only explicit icons and confirms first: its launcher
 * switch can close the app, so it never follows the system automatically.
 */
@Component({
  selector: 'trn-app-icon-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-icon-block.component.html',
  imports: [TrnButton, TrnSelectComponent, SettingsFieldRowDirective],
})
export class AppIconBlockComponent {
  private readonly controller = inject(AppearanceSettingsController);
  private readonly alerts = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = appIconHost();

  protected readonly model = this.controller.axes.appIcon;
  protected readonly status = this.controller.status.appIcon;
  protected readonly hydrationBusy = this.controller.hydrationBusy;
  protected readonly help = HELP[this.host];
  protected readonly options = computed<readonly TrnSelectOption<string>[]>(
    () =>
      this.model.editor.options
        .filter(
          (option) => this.host !== 'android' || option.value !== 'system',
        )
        .map((option) => ({ ...option, testId: `app-icon-${option.value}` })),
  );
  protected readonly value = computed(() => {
    const value = this.model.value();
    return this.host === 'android' && value === 'system' ? 'blurple' : value;
  });

  protected update(value: string | null | undefined): void {
    if (!value || value === this.value()) return;
    if (this.host !== 'android') {
      this.controller.update('appIcon', value);
      return;
    }
    this.alerts
      .confirm$({
        header: 'Change app icon?',
        message: ANDROID_WARNING,
        confirmText: 'Change icon',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((confirmed) => {
        if (confirmed) this.controller.update('appIcon', value);
      });
  }

  protected retry(): void {
    this.controller.retry('appIcon');
  }
}
