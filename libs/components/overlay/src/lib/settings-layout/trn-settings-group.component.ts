import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { TrnSettingsParts, slugify } from './trn-settings-parts';

/** A titled group of settings rows; registers as a navigable part of its settings layout. */
@Component({
  selector: 'trn-settings-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block mt-8' },
  template: `
    @if (title()) {
      <h2
        #heading
        tabindex="-1"
        [id]="headingId()"
        class="m-0 text-xs font-bold text-[var(--trinity-text-muted)] uppercase"
      >
        {{ title() }}
      </h2>
    }
    @if (description()) {
      <p class="m-0 mt-1 text-sm text-[var(--trinity-text-muted)]">
        {{ description() }}
      </p>
    }
    <section class="mt-2" [attr.aria-labelledby]="title() ? headingId() : null">
      <ng-content />
    </section>
  `,
})
export class TrnSettingsGroupComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly parts = inject(TrnSettingsParts, { optional: true });
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  /** Without a title the group is an untitled block: no heading, and not a navigable part. */
  readonly title = input<string>();
  readonly description = input<string>();
  /** Fragment id within the section; defaults to the slug of the title. */
  readonly partId = input<string>();

  protected readonly resolvedId = computed(
    () => this.partId() ?? slugify(this.title() ?? ''),
  );
  protected readonly headingId = computed(() => `part-${this.resolvedId()}`);

  constructor() {
    afterNextRender(() => {
      const heading = this.heading()?.nativeElement;
      if (!this.parts || !heading || !this.title()) {
        return;
      }
      const unregister = this.parts.register({
        id: this.resolvedId(),
        label: this.title() as string,
        heading,
      });
      this.destroyRef.onDestroy(unregister);
    });
  }
}
