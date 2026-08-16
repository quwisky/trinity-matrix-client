import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  TrnRadioGroupComponent,
  type TrnRadioOption,
} from '@trinity/components/radio-group';
import {
  TrnSelectComponent,
  type TrnSelectOption,
} from '@trinity/components/select';
import { TrnCheckboxComponent } from '@trinity/components/checkbox';
import {
  DateTimeFormatService,
  ComposerSettingsService,
  SystemLineSettingsService,
  ThemeService,
  type Palette,
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
    TrnCheckboxComponent,
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

  /**
   * Label for a text-scale id. `hlm-select` renders the collapsed trigger from the bound
   * VALUE rather than the chosen option's markup, so without this the control would read
   * "larger" instead of "Larger". An unknown id falls through rather than blanking it.
   */
  /** Every select's choices, in the shape the wrapper takes. */
  readonly textScaleOptions: readonly TrnSelectOption<string>[] =
    this.theme.textScales.map((scale) => ({
      value: scale.id,
      label: scale.label,
      testId: `text-scale-${scale.id}`,
    }));
  readonly paletteOptions: readonly TrnSelectOption<string>[] =
    this.theme.palettes.map((palette) => ({
      value: palette.id,
      label: palette.label,
      testId: `palette-${palette.id}`,
    }));
  readonly timeFormatOptions: readonly TrnSelectOption<string>[] =
    this.format.timeFormats.map((option) => ({
      value: option.id,
      label: `${option.label} (${this.format.sampleTime(this.sample, option.id)})`,
      testId: `time-format-${option.id}`,
    }));
  readonly dateFormatOptions: readonly TrnSelectOption<string>[] =
    this.format.dateFormats.map((option) => ({
      value: option.id,
      label: `${option.label} (${this.format.sampleDate(this.sample, option.id)})`,
      testId: `date-format-${option.id}`,
    }));
  readonly spaceOrderOptions: readonly TrnSelectOption<string>[] =
    TRINITY_ROOM_SORTS.map((option) => ({
      value: option.id,
      label: option.label,
      description: option.description,
      testId: `space-order-${option.id}`,
    }));

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

  /**
   * What the collapsed trigger shows for the stored id.
   *
   * `hlm-select` renders the trigger from the bound *value*, not from the chosen option's
   * markup, so without this it would read `recent` rather than `Recent activity`. A stable
   * field rather than an inline arrow, which would be a new reference every change detection.
   */

  /** Apply + persist this account's default ordering for spaces with no override. */
  onSpaceOrderChange(value: string | null | undefined): void {
    if (isRoomSortMode(value)) {
      this.spaceOrder.setDefault(value);
    }
  }
}
