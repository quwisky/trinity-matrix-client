import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A feature-local settings heading recipe; it keeps the native h2 and caller-owned id. */
@Component({
  selector: 'trn-settings-section-heading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <header
      class="settings-section-intro"
      [class.settings-section-intro--primary]="primary()"
    >
      <h2
        class="settings-section-heading"
        [class.settings-section-heading--primary]="primary()"
        [id]="headingId()"
      >
        {{ title() }}
      </h2>
      @if (description()) {
        <p class="settings-section-description">{{ description() }}</p>
      }
    </header>
  `,
  styles: `
    .settings-section-intro {
      padding: var(--trinity-space-6) var(--trinity-space-5)
        var(--trinity-space-2);
    }

    .settings-section-intro--primary {
      padding-top: var(--trinity-space-5);
      padding-bottom: var(--trinity-space-3);
    }

    .settings-section-heading {
      margin: 0;
      color: var(--trinity-text-bright);
      font-size: var(--trinity-type-control-size);
      line-height: var(--trinity-type-control-line-height);
      font-weight: 700;
      letter-spacing: 0;
    }

    .settings-section-heading--primary {
      font-size: var(--trinity-type-title-size);
      line-height: var(--trinity-type-title-line-height);
      font-weight: var(--trinity-type-title-weight);
    }

    .settings-section-description {
      max-width: 65ch;
      margin: var(--trinity-space-1) 0 0;
      color: var(--trinity-text-muted);
      font-size: var(--trinity-type-caption-size);
      line-height: var(--trinity-type-caption-line-height);
      text-wrap: pretty;
    }
  `,
})
export class SettingsSectionHeadingComponent {
  readonly title = input.required<string>();
  readonly headingId = input<string>();
  readonly description = input<string>();
  readonly primary = input(false);
}
