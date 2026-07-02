import { Directive, computed, input } from '@angular/core';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ClassValue } from 'clsx';
import { hlm } from '../core/cn';

/**
 * Small status/label pill (shadcn/spartan "helm"). A directive on any inline
 * element (usually `<span>`); `success`/`warning` extend the shadcn set for
 * status indicators (tokens in theme/spartan.css). Replaces `<ion-badge>`.
 */
export const badgeVariants = cva(
  'inline-flex items-center rounded-md border border-solid px-2.5 py-0.5 text-xs font-semibold leading-none transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground',
        success: 'border-transparent bg-success text-success-foreground',
        warning: 'border-transparent bg-warning text-warning-foreground',
        outline: 'text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];

@Directive({
  selector: '[trnBadge]',
  standalone: true,
  host: {
    '[class]': '_computedClass()',
  },
})
export class TrnBadgeDirective {
  readonly userClass = input<ClassValue>('', { alias: 'class' });
  readonly variant = input<BadgeVariant>('default');

  protected readonly _computedClass = computed(() =>
    hlm(badgeVariants({ variant: this.variant() }), this.userClass()),
  );
}
