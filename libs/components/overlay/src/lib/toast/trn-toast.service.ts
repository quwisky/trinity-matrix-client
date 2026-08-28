import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { LiveAnnouncer } from '@angular/cdk/a11y';
import { toast } from '@spartan-ng/brain/sonner';

export type ToastVariant = 'default' | 'destructive' | 'success';

export interface ToastOptions {
  /** Auto-dismiss after this many ms; 0 keeps it until tapped. Default 3000. */
  duration?: number;
  variant?: ToastVariant;
  /**
   * Renders a button on the toast; clicking it runs `onClick` and dismisses.
   *
   * Pair it with `duration: 0` for anything the user must actually decide on — a
   * toast that offers an action and then vanishes on a timer is a prompt the user
   * can lose by looking away.
   */
  action?: { label: string; onClick: () => void };
}

/**
 * Transient toast notifications over spartan's helm **sonner** — the replacement for
 * Ionic's `ToastController`. A single `<hlm-toaster/>` mounted at the app root renders
 * them; this thin service maps our `{ variant, duration }` options onto sonner's
 * imperative `toast()` API so call sites (and their test mocks) stay unchanged. Call
 * `show(message, { variant, duration })`.
 *
 * IMPORTANT: `toast` must come from `@spartan-ng/brain/sonner`, NOT `ngx-sonner`.
 * `<hlm-toaster/>` wraps brain's `<brn-sonner-toaster/>`, which reads brain's own
 * `toastState`. Since spartan 1.1 brain ships its own sonner port (it does not depend
 * on ngx-sonner), so calling ngx-sonner's `toast()` pushes into a *different* store the
 * mounted toaster never observes — the toast is dropped silently, with no error.
 */
@Injectable({ providedIn: 'root' })
export class TrnToastService {
  private readonly document = inject(DOCUMENT);
  private readonly liveAnnouncer = inject(LiveAnnouncer);

  show(message: string, opts: ToastOptions = {}): void {
    const duration = opts.duration ?? 3000;
    // sonner keeps a toast until dismissed when the duration is Infinity; our `0`
    // (Ionic "stay until tapped") maps to that.
    // The `action` key is added only when one was passed, rather than spelled out as
    // `action: opts.action`. sonner treats the key's presence as "render a button",
    // and call sites (and their mocks) assert on this object with exact literals.
    const options = {
      duration: duration > 0 ? duration : Number.POSITIVE_INFINITY,
      ...(opts.action
        ? {
            action: {
              label: opts.action.label,
              // sonner hands the button's MouseEvent to the handler; ours takes no
              // argument, so it is dropped here rather than leaking a DOM type into
              // the option shape every call site would then have to accept.
              onClick: () => opts.action?.onClick(),
            },
          }
        : {}),
    };
    switch (opts.variant) {
      case 'success':
        toast.success(message, options);
        break;
      case 'destructive':
        toast.error(message, options);
        break;
      default:
        toast(message, options);
    }

    // CDK marks the app root aria-hidden while a modal is open. Sonner's live region
    // lives inside that root, so screen readers cannot hear a toast at precisely the
    // moment a dialog error most needs announcing. LiveAnnouncer owns a body-level
    // aria-live node that CDK exempts from hiding. Announce only in this state to avoid
    // duplicating Sonner's normal announcement when no modal is present.
    if (this.document.querySelector('body > trn-root[aria-hidden="true"]')) {
      void this.liveAnnouncer.announce(
        message,
        opts.variant === 'destructive' ? 'assertive' : 'polite',
      );
    }
  }
}
