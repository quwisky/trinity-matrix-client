import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  HlmRadio,
  HlmRadioGroup,
  HlmRadioIndicator,
} from '@trinity/helm/radio-group';
import { ThemeService, type ThemePreference } from '@trinity/platform-native';

/** Appearance settings sub-page: light / dark / system theme preference. */
@Component({
  selector: 'trn-appearance-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appearance-settings.component.html',
  imports: [HlmRadioGroup, HlmRadio, HlmRadioIndicator],
})
export class AppearanceSettingsComponent {
  readonly theme = inject(ThemeService);

  /** Apply + persist the chosen appearance when the radio group changes. */
  onThemeChange(value: string): void {
    this.theme.setPreference(value as ThemePreference);
  }
}
