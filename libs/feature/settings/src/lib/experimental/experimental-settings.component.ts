import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnCheckboxComponent } from '@trinity/components/checkbox';
import { FeatureFlagsService } from '@trinity/platform-native';

/** Experimental settings sub-page: opt-in feature flags. */
@Component({
  selector: 'trn-experimental-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './experimental-settings.component.html',
  imports: [TrnCheckboxComponent],
})
export class ExperimentalSettingsComponent {
  readonly flags = inject(FeatureFlagsService);
}
