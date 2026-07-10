import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import { PrivacySettingsService } from '@trinity/platform-native';

/** Privacy settings sub-page: device-scoped toggles for what others can see. */
@Component({
  selector: 'trn-privacy-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './privacy-settings.component.html',
  imports: [HlmCheckbox],
})
export class PrivacySettingsComponent {
  readonly privacy = inject(PrivacySettingsService);
}
