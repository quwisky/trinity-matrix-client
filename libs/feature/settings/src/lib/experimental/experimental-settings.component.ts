import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnSwitchComponent } from '@trinity/components/controls';
import { FeatureFlagsService } from '@trinity/platform-native';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
} from '@trinity/components/overlay';

/** Experimental settings sub-page: opt-in feature flags. */
@Component({
  selector: 'trn-experimental-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './experimental-settings.component.html',
  imports: [
    TrnSettingsRowComponent,
    TrnSettingsGroupComponent,
    TrnSwitchComponent,
  ],
})
export class ExperimentalSettingsComponent {
  readonly flags = inject(FeatureFlagsService);
}
