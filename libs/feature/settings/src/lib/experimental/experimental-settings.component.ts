import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnCheckbox } from '@trinity/kit/checkbox';
import { FeatureFlagsService } from '@trinity/platform-native';

/** Experimental settings sub-page: opt-in feature flags. */
@Component({
  selector: 'trn-experimental-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './experimental-settings.component.html',
  imports: [TrnCheckbox],
})
export class ExperimentalSettingsComponent {
  readonly flags = inject(FeatureFlagsService);
}
