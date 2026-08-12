import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  TrnRadio,
  TrnRadioGroup,
  TrnRadioIndicator,
} from '@trinity/kit/radio-group';
import {
  TrnSelect,
  TrnSelectContent,
  TrnSelectItem,
  TrnSelectPortal,
  TrnSelectTrigger,
  TrnSelectValue,
} from '@trinity/kit/select';
import { TrnCheckbox } from '@trinity/kit/checkbox';
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
    TrnRadioGroup,
    TrnRadio,
    TrnRadioIndicator,
    TrnSelect,
    TrnSelectTrigger,
    TrnSelectValue,
    TrnSelectContent,
    TrnSelectPortal,
    TrnSelectItem,
    TrnCheckbox,
    CodeAppearanceBlockComponent,
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
   * Label for a text-scale id. `trn-select` renders the collapsed trigger from the bound
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
   * `trn-select` renders the trigger from the bound *value*, not from the chosen option's
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
