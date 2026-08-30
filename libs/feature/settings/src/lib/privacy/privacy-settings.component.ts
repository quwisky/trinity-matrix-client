import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PrivacySettingsService } from '@trinity/platform-native';
import { UrlPreviewService } from '@trinity/data-access/timeline';
import { PreferenceCatalogSectionComponent } from '../shared/preference-catalog-section/preference-catalog-section.component';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading.component';

/** Privacy settings sub-page: device-scoped toggles for what others can see. */
@Component({
  selector: 'trn-privacy-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './privacy-settings.component.html',
  imports: [PreferenceCatalogSectionComponent, SettingsSectionHeadingComponent],
})
export class PrivacySettingsComponent {
  readonly privacy = inject(PrivacySettingsService);

  /**
   * Whether the homeserver provides link previews (`false` once it's known not to), so the
   * page can explain that the previews toggle has no effect on this server.
   */
  readonly previewsSupported = inject(UrlPreviewService).supported;
}
