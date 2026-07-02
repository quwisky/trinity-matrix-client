import { Injectable } from '@angular/core';
import { toast } from 'ngx-sonner';

export type ToastVariant = 'default' | 'destructive' | 'success';

export interface ToastOptions {
  /** Auto-dismiss after this many ms; 0 keeps it until tapped. Default 3000. */
  duration?: number;
  variant?: ToastVariant;
}

/**
 * Transient toast notifications over spartan's helm **sonner** (`ngx-sonner`) — the
 * replacement for Ionic's `ToastController`. A single `<hlm-toaster/>` mounted at the
 * app root renders them; this thin service maps our `{ variant, duration }` options
 * onto sonner's imperative `toast()` API so call sites (and their test mocks) stay
 * unchanged. Call `show(message, { variant, duration })`.
 */
@Injectable({ providedIn: 'root' })
export class TrnToastService {
  show(message: string, opts: ToastOptions = {}): void {
    const duration = opts.duration ?? 3000;
    // sonner keeps a toast until dismissed when the duration is Infinity; our `0`
    // (Ionic "stay until tapped") maps to that.
    const options = {
      duration: duration > 0 ? duration : Number.POSITIVE_INFINITY,
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
  }
}
