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
  SystemLineSettingsService,
  ThemeService,
  type Palette,
  type ThemePreference,
} from '@trinity/platform-native';

/**
 * Appearance settings sub-page: light/dark/system mode, colour palette, and which system
 * lines (joins, profile changes, room changes) the timeline shows.
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
}
