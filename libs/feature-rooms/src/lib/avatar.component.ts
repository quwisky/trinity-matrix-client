import { Component, computed, effect, input, signal } from '@angular/core';

/** Discord-style avatar: best-effort image with a colored initials fallback. */
@Component({
  selector: 'app-avatar',
  template: `
    @if (url() && !failed()) {
      <img
        class="avatar"
        [class.avatar--square]="square()"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [src]="url()"
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
  readonly name = input('');
  readonly initial = input('?');
  readonly size = input(40);
  readonly square = input(false);

  readonly failed = signal(false);

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
    // Reset the error state whenever the source changes (instances are reused
    // across @for rows).
    effect(() => {
      this.url();
      this.failed.set(false);
    });
  }
}
