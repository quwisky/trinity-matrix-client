import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonList,
  IonListHeader,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { ThemeService, type ThemePreference } from '@trinity/core';

/**
 * Settings shell. Currently hosts the Appearance section (light/dark/system theme);
 * Profile and device management land here in later M9 increments.
 */
@Component({
  selector: 'trn-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
  imports: [
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonItem,
    IonList,
    IonListHeader,
    IonNote,
    IonRadio,
    IonRadioGroup,
    IonTitle,
    IonToolbar,
  ],
})
export class SettingsPage {
  readonly theme = inject(ThemeService);

  /** Apply + persist the chosen appearance when the radio group changes. */
  onThemeChange(event: Event): void {
    const value = (event as CustomEvent<{ value: ThemePreference }>).detail
      .value;
    this.theme.setPreference(value);
  }
}
