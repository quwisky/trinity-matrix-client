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

@Directive({
  selector: '[hlmAvatarBadge],hlm-avatar-badge',
  host: {
    'data-slot': 'avatar-badge',
  },
})
export class HlmAvatarBadge {
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
  selector: '[hlmAvatarFallback]',
  exportAs: 'hlmAvatarFallback',
  hostDirectives: [BrnAvatarFallback],
  host: {
    'data-slot': 'avatar-fallback',
  },
})
export class HlmAvatarFallback {
  constructor() {
    classes(
      () =>
        'bg-muted text-muted-foreground rounded-full flex size-full items-center justify-center text-sm group-data-[size=sm]/avatar:text-xs',
    );
  }
}

@Directive({
  selector: '[hlmAvatarGroupCount],hlm-avatar-group-count',
  host: {
    'data-slot': 'avatar-group-count',
  },
})
export class HlmAvatarGroupCount {
  constructor() {
    classes(
      () =>
        'bg-muted text-muted-foreground ring-background relative flex size-8 shrink-0 items-center justify-center rounded-full text-sm ring-2 group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>ng-icon]:text-base group-has-data-[size=lg]/avatar-group:[&>ng-icon]:text-xl group-has-data-[size=sm]/avatar-group:[&>ng-icon]:text-xs',
    );
  }
}

@Directive({
  selector: '[hlmAvatarGroup],hlm-avatar-group',
  host: {
    'data-slot': 'avatar-group',
  },
})
export class HlmAvatarGroup {
  constructor() {
    classes(
      () =>
        '*:data-[slot=avatar]:ring-background group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2',
    );
  }
}

@Directive({
  selector: 'img[hlmAvatarImage]',
  exportAs: 'hlmAvatarImage',
  hostDirectives: [BrnAvatarImage],
  host: {
    'data-slot': 'avatar-image',
  },
})
export class HlmAvatarImage {
  public readonly canShow = inject(BrnAvatarImage).canShow;

  constructor() {
    classes(() => 'rounded-full aspect-square size-full object-cover');
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
        'size-8 rounded-full after:rounded-full data-[size=lg]:size-10 data-[size=sm]:size-6 group/avatar after:border-border relative flex shrink-0 select-none after:absolute after:inset-0 after:border after:mix-blend-darken dark:after:mix-blend-lighten',
    );
  }
}

export const HlmAvatarImports = [
  HlmAvatar,
  HlmAvatarBadge,
  HlmAvatarFallback,
  HlmAvatarGroup,
  HlmAvatarGroupCount,
  HlmAvatarImage,
] as const;
