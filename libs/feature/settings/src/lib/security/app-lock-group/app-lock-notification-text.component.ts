import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  booleanAttribute,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  TrnButton,
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/controls';
import { TrnSettingsRowComponent } from '@trinity/components/overlay';
import type { NotificationText } from '@trinity/data-access/app-lock';
import { AppSettingsService } from '@trinity/platform-native';
import { HostLifecycleService } from '@trinity/runtime/host';
import { EMPTY, catchError, filter, map, of, startWith, switchMap } from 'rxjs';

/**
 * Settings › Security › App lock › Notification text. "Hide on the lock screen" (phones only)
 * follows the phone's own lock-screen setting, so it says so and links to it. The group runs
 * the guarded change and passes the choice to show.
 */
@Component({
  selector: 'trn-app-lock-notification-text',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app-lock-notification-text.component.html',
  host: { class: 'block' },
  imports: [TrnButton, TrnRadioGroupComponent, TrnSettingsRowComponent],
})
export class AppLockNotificationTextComponent {
  private readonly appSettings = inject(AppSettingsService);
  private readonly lifecycle = inject(HostLifecycleService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly options = computed(
    (): readonly TrnRadioOption<NotificationText>[] => [
      {
        value: 'show',
        label: 'Show',
        description:
          'Notifications show who wrote, in which room, and the message.',
        testId: 'app-lock-text-show',
      },
      ...(this.lockScreenOffered()
        ? [
            {
              value: 'hide-on-lock-screen' as const,
              label: 'Hide on the lock screen',
              description:
                'The lock screen hides who wrote and what; the full text shows once your phone is unlocked. Follows your phone’s lock-screen notification setting.',
              testId: 'app-lock-text-lock-screen',
            },
          ]
        : []),
      {
        value: 'always-hide',
        label: 'Always hide',
        description: 'Notifications say only “New message”, everywhere.',
        testId: 'app-lock-text-always',
      },
    ],
  );
  protected readonly canOpenSettings = this.appSettings.available;
  /**
   * iOS shows previews on the lock screen (Show Previews: Always), where nothing can hide
   * them there. Read again whenever the app comes back, as the link leads to that setting.
   */
  protected readonly previewsShown = toSignal(
    this.appSettings.available
      ? this.lifecycle.events.pipe(
          // A lifecycle that fails still leaves the first read.
          catchError(() => EMPTY),
          filter((event) => event.kind === 'active'),
          startWith(null),
          switchMap(() => this.appSettings.previewSetting()),
          map((setting) => setting === 'always'),
        )
      : of(false),
    { initialValue: false },
  );

  /** The choice to show: the stored one, or one whose change is being confirmed. */
  readonly value = input.required<NotificationText>();
  readonly disabled = input(false, { transform: booleanAttribute });
  /** Phones only: a desktop has no lock-screen notification setting to follow. */
  readonly lockScreenOffered = input.required<boolean>();
  readonly valueChange = output<NotificationText>();

  protected openSettings(): void {
    this.appSettings
      .openNotificationSettings()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }
}
