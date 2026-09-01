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
  TrnRadioGroupComponent,
  type TrnRadioOption,
  TrnSelectComponent,
  type TrnSelectOption,
  TrnSwitchComponent,
} from '@trinity/components/controls';
import {
  DateTimeFormatService,
  ComposerSettingsService,
  SystemLineSettingsService,
} from '@trinity/platform-native';
import {
  SpaceRoomOrderService,
  TRINITY_ROOM_SORTS,
  isRoomSortMode,
} from '@trinity/data-access/room-library';
import { isDateFormat, isTimeFormat } from '@trinity/util/matrix';
import { CodeAppearanceBlockComponent } from './code-appearance-block.component';
import {
  AppearancePreferenceFieldComponent,
  type AppearancePreferenceField,
} from './appearance-preference-field/appearance-preference-field.component';
import { AppearanceSettingsController } from './appearance-settings.controller';
import { MessageGesturesBlockComponent } from './message-gestures-block.component';
import { AppearancePreviewComponent } from './appearance-preview.component';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading.component';
import { SettingsToggleRowDirective } from '../shared/settings-toggle-row.directive';
import { SettingsFieldRowDirective } from '../shared/settings-field-row.directive';
import { SettingsGroupComponent } from '../shared/settings-group/settings-group.component';

/**
 * Appearance settings sub-page: Mode, Theme, text and code size,
 * how dates and times are written, how rooms are ordered inside a space, and which system
 * lines (joins, profile changes, room changes) the timeline shows.
 *
 * Code display lives in its own child block — it is a coherent group, and this template was
 * already at the size the repo refactors at.
 */
@Component({
  selector: 'trn-appearance-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appearance-settings.component.html',
  providers: [AppearanceSettingsController],
  imports: [
    TrnButton,
    TrnRadioGroupComponent,
    TrnSelectComponent,
    TrnSwitchComponent,
    CodeAppearanceBlockComponent,
    AppearancePreferenceFieldComponent,
    MessageGesturesBlockComponent,
    AppearancePreviewComponent,
    SettingsSectionHeadingComponent,
    SettingsToggleRowDirective,
    SettingsFieldRowDirective,
    SettingsGroupComponent,
  ],
})
export class AppearanceSettingsComponent {
  private readonly destroyRef = inject(DestroyRef);

  readonly appearance = inject(AppearanceSettingsController);
  /** Light/dark/system, in the shape the radio group takes. */
  readonly modeOptions: readonly TrnRadioOption<string>[] =
    this.appearance.axes.mode.editor.options.map(({ value, label }) => ({
      value,
      label,
      testId: `mode-${value}`,
    }));
  readonly themeField = {
    axis: 'theme',
    headingId: 'appearance-theme-heading',
    testId: 'theme-select',
    optionTestIdPrefix: 'theme',
  } as const satisfies AppearancePreferenceField;
  readonly densityField = {
    axis: 'density',
    headingId: 'appearance-density-heading',
    testId: 'density-select',
    optionTestIdPrefix: 'density',
  } as const satisfies AppearancePreferenceField;
  readonly textSizeField = {
    axis: 'textSize',
    headingId: 'appearance-text-size-heading',
    testId: 'text-scale-select',
    optionTestIdPrefix: 'text-scale',
  } as const satisfies AppearancePreferenceField;
  readonly systemLines = inject(SystemLineSettingsService);
  readonly composer = inject(ComposerSettingsService);
  readonly format = inject(DateTimeFormatService);
  readonly spaceOrder = inject(SpaceRoomOrderService);

  /**
   * The instant every format option is previewed against.
   *
   * A fixed afternoon rather than `Date.now()`, so the samples are stable while the page is
   * open and each option differs only by its format. Mid-afternoon on a two-digit day of a
   * single-digit month, so 12- vs 24-hour and every date order are all visibly distinct.
   */
  readonly sample = new Date(2026, 6, 24, 15, 45).getTime();

  readonly resolvedMode = computed(
    () =>
      this.appearance.resolved()?.mode ??
      (this.appearance.axes.mode.value() === 'light' ? 'light' : 'dark'),
  );
  readonly themeLabel = computed(() => this.labelFor('theme'));
  readonly densityLabel = computed(() => this.labelFor('density'));

  /** Persist the chosen Mode; projection observes it only after the command commits. */
  onModeChange(value: string): void {
    this.appearance.update('mode', value);
  }
  /**
   * `computed`, not a field initializer, because the preview text is not static.
   *
   * `sample` is a fixed instant on purpose, but `sampleTime` formats it through
   * `format.prefs()` — whose locales come from a `languagechange` listener. Android keeps
   * the WebView alive across an OS language change (`locale` is in the Activity's
   * `configChanges`), so the paragraph below, still a live template call, re-renders in the
   * new locale while a list built once at construction would keep showing the old one — the
   * same screen previewing "Match system" two contradictory ways.
   */
  readonly timeFormatOptions = computed<readonly TrnSelectOption<string>[]>(
    () =>
      this.format.timeFormats.map((option) => ({
        value: option.id,
        label: `${option.label} (${this.format.sampleTime(this.sample, option.id)})`,
        testId: `time-format-${option.id}`,
      })),
  );
  /** Reactive for the same reason as {@link timeFormatOptions}. */
  readonly dateFormatOptions = computed<readonly TrnSelectOption<string>[]>(
    () =>
      this.format.dateFormats.map((option) => ({
        value: option.id,
        label: `${option.label} (${this.format.sampleDate(this.sample, option.id)})`,
        testId: `date-format-${option.id}`,
      })),
  );
  readonly spaceOrderOptions: readonly TrnSelectOption<string>[] =
    TRINITY_ROOM_SORTS.map((option) => ({
      value: option.id,
      label: option.label,
      description: option.description,
      testId: `space-order-${option.id}`,
    }));

  /** Apply + persist how the clock is written. */
  onTimeFormatChange(value: string | null | undefined): void {
    if (isTimeFormat(value)) {
      this.format.setTimeFormat(value);
    }
  }

  /** Apply + persist how a date is ordered. */
  onDateFormatChange(value: string | null | undefined): void {
    if (isDateFormat(value)) {
      this.format.setDateFormat(value);
    }
  }

  /** Apply + persist this account's default ordering for spaces with no override. */
  onSpaceOrderChange(value: string | null | undefined): void {
    if (isRoomSortMode(value)) {
      this.spaceOrder
        .setDefault(value)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          error: (err: unknown) =>
            console.error('Could not save the room ordering preference', err),
        });
    }
  }

  private labelFor(axis: 'theme' | 'density'): string {
    const model = this.appearance.axes[axis];
    const value = model.value();
    return (
      model.editor.options.find((option) => option.value === value)?.label ??
      value
    );
  }
}
