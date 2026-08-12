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
import { classes } from '@trinity/kit/utils';

/**
 * ┌─ VENDORED FILE — @spartan-ng/cli generated, then diverged ────────────────────────────┐
 *
 * One deliberate local override: every `hostDirectives` entry states its `inputs` and
 * `outputs` explicitly, even when both are empty. `hostDirectives` is public API — a
 * composed directive's input or output is bindable on our element only if the entry lists
 * it — so the generator's shorthand form makes that decision by omission. It hid a real
 * defect once: `TrnInput` composed `BrnFieldControlDescribedBy` without listing
 * `aria-describedby`, so the attribute was silently overwritten with null (#153).
 *
 * A regenerate drops this and restores the shorthand. `scripts/host-directives.spec.mjs`
 * fails when it does, rather than letting it ship. See "Registered vendored divergences"
 * in docs/architecture/ui-and-theming.md.
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 */

@Directive({
  selector: '[trnAvatarBadge],trn-avatar-badge',
  host: {
    'data-slot': 'avatar-badge',
  },
})
export class TrnAvatarBadge {
  constructor() {
    classes(() => [
      'bg-primary text-primary-foreground ring-background absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-blend-color ring-2 select-none',
      'group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>ng-icon]:hidden',
      'group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>ng-icon]:text-[length:--spacing(2)]',
      'group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>ng-icon]:text-[length:--spacing(2)]',
    ]);
  }
}

@Directive({
  selector: '[trnAvatarFallback]',
  exportAs: 'trnAvatarFallback',
  hostDirectives: [
    { directive: BrnAvatarFallback, inputs: [], outputs: [] },
  ],
  host: {
    'data-slot': 'avatar-fallback',
  },
})
export class TrnAvatarFallback {
  constructor() {
    classes(
      () =>
        'bg-muted text-muted-foreground rounded-full flex size-full items-center justify-center text-sm group-data-[size=sm]/avatar:text-xs',
    );
  }
}

@Directive({
  selector: '[trnAvatarGroupCount],trn-avatar-group-count',
  host: {
    'data-slot': 'avatar-group-count',
  },
})
export class TrnAvatarGroupCount {
  constructor() {
    classes(
      () =>
        'bg-muted text-muted-foreground ring-background relative flex size-8 shrink-0 items-center justify-center rounded-full text-sm ring-2 group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>ng-icon]:text-base group-has-data-[size=lg]/avatar-group:[&>ng-icon]:text-xl group-has-data-[size=sm]/avatar-group:[&>ng-icon]:text-xs',
    );
  }
}

@Directive({
  selector: '[trnAvatarGroup],trn-avatar-group',
  host: {
    'data-slot': 'avatar-group',
  },
})
export class TrnAvatarGroup {
  constructor() {
    classes(
      () =>
        '*:data-[slot=avatar]:ring-background group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2',
    );
  }
}

@Directive({
  selector: 'img[trnAvatarImage]',
  exportAs: 'trnAvatarImage',
  hostDirectives: [
    { directive: BrnAvatarImage, inputs: [], outputs: [] },
  ],
  host: {
    'data-slot': 'avatar-image',
  },
})
export class TrnAvatarImage {
  public readonly canShow = inject(BrnAvatarImage).canShow;

  constructor() {
    classes(() => 'rounded-full aspect-square size-full object-cover');
  }
}

@Component({
  selector: 'trn-avatar-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'avatar',
    '[attr.data-size]': 'size()',
  },
  template: `
    @if (_image()?.canShow()) {
      <ng-content select="[trnAvatarImage],[brnAvatarImage]" />
    } @else {
      <ng-content select="[trnAvatarFallback],[brnAvatarFallback]" />
    }
    <ng-content />
  `,
})
export class TrnAvatar extends BrnAvatar {
  public readonly size = input<'default' | 'sm' | 'lg'>('default');

  constructor() {
    super();
    classes(
      () =>
        'size-8 rounded-full after:rounded-full data-[size=lg]:size-10 data-[size=sm]:size-6 group/avatar after:border-border relative flex shrink-0 select-none after:absolute after:inset-0 after:border after:mix-blend-darken dark:after:mix-blend-lighten',
    );
  }
}

export const TrnAvatarImports = [
  TrnAvatar,
  TrnAvatarBadge,
  TrnAvatarFallback,
  TrnAvatarGroup,
  TrnAvatarGroupCount,
  TrnAvatarImage,
] as const;
