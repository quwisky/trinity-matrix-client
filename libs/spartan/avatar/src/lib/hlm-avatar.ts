import {
  BrnAvatar,
  BrnAvatarFallback,
  BrnAvatarImage,
} from '@spartan-ng/brain/avatar';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  inject,
  input,
} from '@angular/core';
import { classes } from '@trinity/helm/utils';

/**
 * ┌─ VENDORED FILE — @spartan-ng/cli generated, then diverged ────────────────────────────┐
 *
 * Two deliberate local overrides. First, every `hostDirectives` entry states its `inputs` and
 * `outputs` explicitly, even when both are empty. `hostDirectives` is public API — a
 * composed directive's input or output is bindable on our element only if the entry lists
 * it — so the generator's shorthand form makes that decision by omission. It hid a real
 * defect once: `HlmInput` composed `BrnFieldControlDescribedBy` without listing
 * `aria-describedby`, so the attribute was silently overwritten with null (#153).
 *
 * A regenerate drops this and restores the shorthand. `scripts/host-directives.spec.mjs`
 * fails when it does, rather than letting it ship. See "Registered vendored divergences"
 * in the developer UI and theming guide.
 *
 * Second, the avatar, fallback, image and decorative outline consume Trinity's inherited
 * `--trn-avatar-radius` when present, retaining Helm's full radius as their standalone fallback.
 * The generated `rounded-full` utilities otherwise outrank the public wrapper's component-layer
 * shape rule and turn rooms and spaces back into circles. `theme-foundation-contract.spec.mjs`
 * pins all four consumers.
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 */

@Directive({
  selector: '[hlmAvatarFallback]',
  exportAs: 'hlmAvatarFallback',
  hostDirectives: [
    { directive: BrnAvatarFallback, inputs: [], outputs: [] },
  ],
  host: {
    'data-slot': 'avatar-fallback',
  },
})
export class HlmAvatarFallback {
  constructor() {
    classes(
      () =>
        'bg-muted text-muted-foreground rounded-[var(--trn-avatar-radius,var(--radius-full))] flex size-full items-center justify-center text-sm group-data-[size=sm]/avatar:text-xs',
    );
  }
}

@Directive({
  selector: 'img[hlmAvatarImage]',
  exportAs: 'hlmAvatarImage',
  hostDirectives: [
    { directive: BrnAvatarImage, inputs: [], outputs: [] },
  ],
  host: {
    'data-slot': 'avatar-image',
  },
})
export class HlmAvatarImage {
  public readonly canShow = inject(BrnAvatarImage).canShow;

  constructor() {
    classes(
      () =>
        'rounded-[var(--trn-avatar-radius,var(--radius-full))] aspect-square size-full object-cover',
    );
  }
}

@Component({
  selector: 'hlm-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'avatar',
    '[attr.data-size]': 'size()',
  },
  template: `
    @if (_image()?.canShow()) {
      <ng-content select="[hlmAvatarImage],[brnAvatarImage]" />
    } @else {
      <ng-content select="[hlmAvatarFallback],[brnAvatarFallback]" />
    }
    <ng-content />
  `,
})
export class HlmAvatar extends BrnAvatar {
  public readonly size = input<'default' | 'sm' | 'lg'>('default');

  constructor() {
    super();
    classes(
      () =>
        'size-8 rounded-[var(--trn-avatar-radius,var(--radius-full))] after:rounded-[var(--trn-avatar-radius,var(--radius-full))] data-[size=lg]:size-10 data-[size=sm]:size-6 group/avatar after:border-foreground/10 relative flex shrink-0 select-none after:absolute after:inset-0 after:border',
    );
  }
}
