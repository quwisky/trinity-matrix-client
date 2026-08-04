import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  HlmRadio,
  HlmRadioGroup,
  HlmRadioIndicator,
} from '@trinity/helm/radio-group';
import {
  HlmSelect,
  HlmSelectContent,
  HlmSelectItem,
  HlmSelectPortal,
  HlmSelectTrigger,
  HlmSelectValue,
} from '@trinity/helm/select';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import {
  DateTimeFormatService,
  ComposerSettingsService,
  SystemLineSettingsService,
  ThemeService,
  TRINITY_TEXT_SCALES,
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

/**
 * Appearance settings sub-page: light/dark/system mode, colour palette, how dates and times
 * are written, how rooms are ordered inside a space, and which system lines (joins, profile
 * changes, room changes) the timeline shows.
 */
@Component({
  selector: 'trn-appearance-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appearance-settings.component.html',
  imports: [
    HlmRadioGroup,
    HlmRadio,
    HlmRadioIndicator,
    HlmSelect,
    HlmSelectTrigger,
    HlmSelectValue,
    HlmSelectContent,
    HlmSelectPortal,
    HlmSelectItem,
    HlmCheckbox,
  ],
})
export class AppearanceSettingsComponent {
  readonly theme = inject(ThemeService);
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
  readonly textScaleLabel = (scale: string): string =>
    TRINITY_TEXT_SCALES.find((entry) => entry.id === scale)?.label ?? scale;

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
  readonly spaceOrderLabel = (mode: string): string =>
    TRINITY_ROOM_SORTS.find((option) => option.id === mode)?.label ?? mode;

  /** Apply + persist this account's default ordering for spaces with no override. */
  onSpaceOrderChange(value: string | null | undefined): void {
    if (isRoomSortMode(value)) {
      this.spaceOrder.setDefault(value);
    }
  }
}
