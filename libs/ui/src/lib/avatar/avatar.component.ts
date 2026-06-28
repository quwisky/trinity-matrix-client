import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { AVATAR_RESOLVER } from './avatar-resolver';

/**
 * Discord-style avatar: best-effort image with a colored initials fallback. Bind
 * either a ready `url`, or an `mxc` which is resolved via the injected
 * {@link AVATAR_RESOLVER} (authenticated blob URL) when one is provided.
 */
@Component({
  selector: 'trn-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (src() && !failed()) {
      <img
        class="avatar"
        [class.avatar--square]="square()"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [src]="src()"
        [alt]="name()"
        (error)="failed.set(true)"
      />
    } @else {
      <span
        class="avatar avatar--fallback"
        [class.avatar--square]="square()"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [style.font-size.px]="size() * 0.4"
        [style.background]="color()"
        >{{ initial() }}</span
      >
    }
  `,
  styles: [
    `
      :host {
        display: inline-flex;
      }
      .avatar {
        border-radius: 50%;
        object-fit: cover;
        flex: 0 0 auto;
      }
      .avatar--square {
        border-radius: 30%;
      }
      .avatar--fallback {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        font-weight: 600;
        line-height: 1;
        user-select: none;
      }
    `,
  ],
})
export class AvatarComponent {
  readonly url = input<string | null>(null);
  /** Raw `mxc://`; resolved via {@link AVATAR_RESOLVER} when one is provided. */
  readonly mxc = input<string | null>(null);
  readonly name = input('');
  readonly initial = input('?');
  readonly size = input(40);
  readonly square = input(false);

  private readonly resolver = inject(AVATAR_RESOLVER, { optional: true });

  readonly failed = signal(false);
  /** URL resolved from `mxc` via the resolver (null until resolved / no resolver). */
  private readonly resolvedUrl = signal<string | null>(null);

  /** The image source actually shown: a resolved mxc wins, else the direct `url`. */
  readonly src = computed(() => this.resolvedUrl() ?? this.url());

  /** Stable color picked from the name, like Discord's default avatars. */
  readonly color = computed(() => {
    const palette = [
      '#5865f2',
      '#3ba55d',
      '#faa81a',
      '#ed4245',
      '#eb459e',
      '#9b59b6',
    ];
    const key = this.name() || this.initial();
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return palette[Math.abs(hash) % palette.length];
  });

  constructor() {
    // Re-resolve when the bound avatar changes (instances are reused across @for
    // rows). Reset the error/resolved state, then resolve `mxc` via the resolver
    // when both are present; the subscription is torn down on the next run/destroy.
    effect((onCleanup) => {
      const mxc = this.mxc();
      const size = this.size();
      this.url(); // track so a direct-url change also resets the error state
      this.failed.set(false);
      this.resolvedUrl.set(null);
      if (mxc && this.resolver) {
        const sub = this.resolver(mxc, size).subscribe((resolved) =>
          this.resolvedUrl.set(resolved),
        );
        onCleanup(() => sub.unsubscribe());
      }
    });
  }
}
