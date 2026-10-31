import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { toast } from '@spartan-ng/brain/sonner';
import type { TrnVariant } from '@trinity/components/foundations';

export type TrnToastVariant = Extract<
  TrnVariant,
  'neutral' | 'success' | 'warning' | 'danger'
>;
export interface ToastOptions {
  /** Auto-dismiss after this many ms; 0 keeps it until closed. Default 3000. */
  duration?: number;
  variant?: TrnToastVariant;
  /**
   * Renders a button on the toast; clicking it runs `onClick` and dismisses.
   *
   * Pair it with `duration: 0` for anything the user must decide on: an action that vanishes
   * on a timer is a prompt the user can lose by looking away.
   */
  action?: { label: string; onClick: () => void };
}

/**
 * Transient toast notifications over spartan's helm **sonner**. A single `<trn-toaster/>` at
 * the app root renders them; this thin service maps our `{ variant, duration }` options onto
 * sonner's imperative `toast()` API.
 *
 * IMPORTANT: `toast` must come from `@spartan-ng/brain/sonner`, NOT `ngx-sonner`.
 * `<trn-toaster/>` wraps brain's `<brn-sonner-toaster/>`, which reads brain's own
 * `toastState`. Since spartan 1.1 brain ships its own sonner port, so calling ngx-sonner's
 * `toast()` pushes into a *different* store the mounted toaster never observes: the toast is
 * dropped silently, with no error.
 */
@Injectable({ providedIn: 'root' })
export class TrnToastService {
  private readonly document = inject(DOCUMENT);
  private readonly liveAnnouncer = inject(LiveAnnouncer);

  show(message: string, opts: ToastOptions = {}): void {
    const duration = opts.duration ?? 3000;
    const variant = opts.variant ?? 'neutral';
    // sonner keeps a toast until dismissed when the duration is Infinity; our `0` maps to that.
    // The `action` key is added only when one was passed: sonner treats the key's presence as
    // "render a button", and call sites (and their mocks) assert on exact literals.
    const options = {
      duration: duration > 0 ? duration : Number.POSITIVE_INFINITY,
      // A toast that stays must be closable: it sits over the header's controls on a phone.
      ...(duration > 0 ? {} : { closeButton: true }),
      ...(opts.action
        ? {
            action: {
              label: opts.action.label,
              // sonner hands the button's MouseEvent to the handler; ours takes no argument, so
              // no DOM type leaks into the option shape.
              onClick: () => opts.action?.onClick(),
            },
          }
        : {}),
    };
    switch (variant) {
      case 'success':
        toast.success(message, options);
        break;
      case 'warning':
        toast.warning(message, options);
        break;
      case 'danger':
        toast.error(message, options);
        break;
      default:
        toast(message, options);
    }

    // CDK marks the app root aria-hidden while a modal is open, and sonner's live region lives
    // inside that root, so screen readers cannot hear a toast exactly when a dialog error needs
    // announcing. LiveAnnouncer owns a body-level aria-live node that CDK exempts from hiding.
    // Announce only in this state, to avoid duplicating sonner's own announcement.
    if (this.document.querySelector('body > trn-root[aria-hidden="true"]')) {
      void this.liveAnnouncer.announce(
        message,
        variant === 'danger' ? 'assertive' : 'polite',
      );
    }
  }
}
