import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnSwitchComponent } from '@trinity/components/switch';
import { FeatureFlagsService } from '@trinity/platform-native';

/** Experimental settings sub-page: opt-in feature flags. */
@Component({
  selector: 'trn-experimental-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './experimental-settings.component.html',
  imports: [TrnSwitchComponent],
})
export class ExperimentalSettingsComponent {
  readonly flags = inject(FeatureFlagsService);
}
