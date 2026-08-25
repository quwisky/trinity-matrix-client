import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/radio-group';
import {
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/select';
import { TrnSwitchComponent } from '@trinity/components/switch';
import {
  DateTimeFormatService,
  ComposerSettingsService,
  SystemLineSettingsService,
  ThemeService,
  type Palette,
  type Density,
  type TextScale,
  type ThemePreference,
} from '@trinity/platform-native';
import {
  SpaceRoomOrderService,
  TRINITY_ROOM_SORTS,
  isRoomSortMode,
} from '@trinity/data-access/rooms';
import { isDateFormat, isTimeFormat } from '@trinity/util/matrix';
import { CodeAppearanceBlockComponent } from './code-appearance-block.component';

/**
 * Appearance settings sub-page: light/dark/system mode, colour palette, text and code size,
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
  imports: [
    TrnRadioGroupComponent,
    TrnSelectComponent,
    TrnSwitchComponent,
    CodeAppearanceBlockComponent,
  ],
})
export class AppearanceSettingsComponent {
  readonly theme = inject(ThemeService);
  /** Light/dark/system, in the shape the radio group takes. */
  readonly themeOptions: readonly TrnRadioOption<ThemePreference>[] = [
    { value: 'system', label: 'Use system setting', testId: 'theme-system' },
    { value: 'light', label: 'Light', testId: 'theme-light' },
    { value: 'dark', label: 'Dark', testId: 'theme-dark' },
  ];
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

  /** Apply + persist the chosen light/dark mode when the radio group changes. */
  onThemeChange(value: string): void {
    this.theme.setPreference(value as ThemePreference);
  }

  /** Apply + persist the chosen colour palette when the dropdown changes. */
  onPaletteChange(value: string | null | undefined): void {
    if (value) {
      this.theme.setPalette(value as Palette);
    }
  }

  /** Every select's choices, in the shape the wrapper takes. */
  readonly textScaleOptions: readonly TrnSelectOption<string>[] =
    this.theme.textScales.map((scale) => ({
      value: scale.id,
      label: scale.label,
      testId: `text-scale-${scale.id}`,
    }));

  readonly densityOptions: readonly TrnSelectOption<string>[] =
    this.theme.densities.map((density) => ({
      value: density.id,
      label: density.label,
      testId: `density-${density.id}`,
    }));
  readonly paletteOptions: readonly TrnSelectOption<string>[] =
    this.theme.palettes.map((palette) => ({
      value: palette.id,
      label: palette.label,
      testId: `palette-${palette.id}`,
    }));
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

  /** Apply + persist how much room the app leaves around things. */
  onDensityChange(value: string | null | undefined): void {
    // Guarded like every other choice here: the select is ours, but `valueChange` is a
    // string and the setter takes a union — narrowing against the registered list is what
    // keeps a stale saved value or a typo out of the token attribute.
    if (this.theme.densities.some((density) => density.id === value)) {
      this.theme.setDensity(value as Density);
    }
  }

  /** Apply + persist how large text is. */
  onTextScaleChange(value: string | null | undefined): void {
    if (this.theme.textScales.some((scale) => scale.id === value)) {
      this.theme.setTextScale(value as TextScale);
    }
  }

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
      this.spaceOrder.setDefault(value);
    }
  }
}
