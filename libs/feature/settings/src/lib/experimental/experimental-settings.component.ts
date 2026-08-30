import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnSwitchComponent } from '@trinity/components/controls';
import { FeatureFlagsService } from '@trinity/platform-native';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading.component';
import { SettingsToggleRowDirective } from '../shared/settings-toggle-row.directive';

/** Experimental settings sub-page: opt-in feature flags. */
@Component({
  selector: 'trn-experimental-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './experimental-settings.component.html',
  imports: [
    TrnSwitchComponent,
    SettingsSectionHeadingComponent,
    SettingsToggleRowDirective,
  ],
})
export class ExperimentalSettingsComponent {
  readonly flags = inject(FeatureFlagsService);
}
