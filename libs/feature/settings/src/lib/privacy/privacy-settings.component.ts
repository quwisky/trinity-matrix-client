import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnCheckboxComponent } from '@trinity/components/checkbox';
import { PrivacySettingsService } from '@trinity/platform-native';
import { UrlPreviewService } from '@trinity/data-access/timeline';

/** Privacy settings sub-page: device-scoped toggles for what others can see. */
@Component({
  selector: 'trn-privacy-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './privacy-settings.component.html',
  imports: [TrnCheckboxComponent],
})
export class PrivacySettingsComponent {
  readonly privacy = inject(PrivacySettingsService);

  /**
   * Whether the homeserver provides link previews (`false` once it's known not to), so the
   * page can explain that the previews toggle has no effect on this server.
   */
  readonly previewsSupported = inject(UrlPreviewService).supported;
}
