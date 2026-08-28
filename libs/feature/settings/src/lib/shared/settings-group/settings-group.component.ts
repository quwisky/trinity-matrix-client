import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Groups related Settings controls without turning every cluster into a card. */
@Component({
  selector: 'trn-settings-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
  },
  template: `
    <section
      class="grid gap-[var(--trinity-space-4)]"
      [attr.aria-labelledby]="headingId()"
    >
      <header>
        <h3
          class="m-0 text-[length:var(--trinity-type-body-size)] leading-[var(--trinity-type-body-line-height)] font-semibold text-[var(--trinity-text-bright)]"
          [id]="headingId()"
        >
          {{ title() }}
        </h3>
        @if (description()) {
          <p
            class="mt-[var(--trinity-space-1)] max-w-[65ch] text-[length:var(--trinity-type-caption-size)] leading-[var(--trinity-type-caption-line-height)] text-[var(--trinity-text-muted)]"
          >
            {{ description() }}
          </p>
        }
      </header>
      <ng-content />
    </section>
  `,
})
export class SettingsGroupComponent {
  readonly title = input.required<string>();
  readonly headingId = input.required<string>();
  readonly description = input<string>();
}
