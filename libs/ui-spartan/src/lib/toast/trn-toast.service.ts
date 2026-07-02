import { Injectable, inject, signal } from '@angular/core';
import { Overlay, type OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { TrnToastContainerComponent } from './trn-toast-container.component';

export type ToastVariant = 'default' | 'destructive' | 'success';

export interface ToastOptions {
  /** Auto-dismiss after this many ms; 0 keeps it until tapped. Default 3000. */
  duration?: number;
  variant?: ToastVariant;
}

interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

let nextId = 0;

/**
 * Transient toast notifications — the spartan replacement for Ionic's
 * `ToastController`. Lazily mounts a {@link TrnToastContainerComponent} into a
 * single bottom-center CDK overlay, then pushes messages to a signal the
 * container renders. Call `show(message, { variant, duration })`.
 */
@Injectable({ providedIn: 'root' })
export class TrnToastService {
  private readonly overlay = inject(Overlay);
  private overlayRef: OverlayRef | null = null;

  readonly toasts = signal<ToastItem[]>([]);

  show(message: string, opts: ToastOptions = {}): void {
    this.ensureContainer();
    const id = nextId++;
    this.toasts.update((list) => [
      ...list,
      { id, message, variant: opts.variant ?? 'default' },
    ]);
    const duration = opts.duration ?? 3000;
    if (duration > 0) {
      setTimeout(() => this.dismiss(id), duration);
    }
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }

  private ensureContainer(): void {
    if (this.overlayRef) {
      return;
    }
    this.overlayRef = this.overlay.create({
      positionStrategy: this.overlay
        .position()
        .global()
        .bottom('20px')
        .centerHorizontally(),
    });
    this.overlayRef.attach(new ComponentPortal(TrnToastContainerComponent));
  }
}
