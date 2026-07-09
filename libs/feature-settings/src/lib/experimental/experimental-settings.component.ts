import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { FeatureFlagsService } from '@trinity/platform-native';

/** Experimental settings sub-page: opt-in feature flags. */
@Component({
  selector: 'trn-experimental-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './experimental-settings.component.html',
  imports: [HlmCheckbox],
})
export class ExperimentalSettingsComponent {
  readonly flags = inject(FeatureFlagsService);
}
