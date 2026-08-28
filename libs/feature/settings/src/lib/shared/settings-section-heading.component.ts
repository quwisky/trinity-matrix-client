import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A feature-local settings heading recipe; it keeps the native h2 and caller-owned id. */
@Component({
  selector: 'trn-settings-section-heading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <h2
      class="settings-section-heading"
      [class.settings-section-heading--primary]="primary()"
      [id]="headingId()"
    >
      {{ title() }}
    </h2>
  `,
  styles: `
    .settings-section-heading {
      margin: 0;
      padding: var(--trinity-space-6) var(--trinity-space-5)
        var(--trinity-space-2);
      color: var(--trinity-text-bright);
      font-size: var(--trinity-type-control-size);
      line-height: var(--trinity-type-control-line-height);
      font-weight: 700;
      letter-spacing: 0;
    }

    .settings-section-heading--primary {
      padding-top: var(--trinity-space-5);
      font-size: var(--trinity-type-title-size);
      line-height: var(--trinity-type-title-line-height);
      font-weight: var(--trinity-type-title-weight);
    }
  `,
})
export class SettingsSectionHeadingComponent {
  readonly title = input.required<string>();
  readonly headingId = input<string>();
  readonly primary = input(false);
}
