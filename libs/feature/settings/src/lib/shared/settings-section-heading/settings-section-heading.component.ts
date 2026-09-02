import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A feature-local settings heading recipe; it keeps the native h2 and caller-owned id. */
@Component({
  selector: 'trn-settings-section-heading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  templateUrl: './settings-section-heading.component.html',
  styleUrl: './settings-section-heading.component.scss',
})
export class SettingsSectionHeadingComponent {
  readonly title = input.required<string>();
  readonly headingId = input<string>();
  readonly description = input<string>();
  readonly primary = input(false);
}
