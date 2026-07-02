import { Injectable, inject } from '@angular/core';
import { Dialog, DialogRef } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import type { ComponentType } from '@angular/cdk/portal';
import { firstValueFrom } from 'rxjs';

export interface DialogOptions {
  /** Set on the opened component as @Inputs after creation (Ionic componentProps). */
  inputs?: Record<string, unknown>;
  /** Extra class(es) on the dialog panel (for width/height/position styling). */
  panelClass?: string | string[];
  /**
   * Where the panel sits. `'center'` (default) is a centered modal card;
   * `'end'` pins it full-height against the inline-end (right) edge — the
   * split-pane side panel (the panel supplies its own width/height). Replaces the
   * Ionic `justify-content: flex-end` modal css.
   */
  side?: 'center' | 'end';
  /** Prevent backdrop/escape close (Ionic backdropDismiss: false). */
  disableClose?: boolean;
  /** Injected as DIALOG_DATA, for components that read data instead of inputs. */
  data?: unknown;
}

/**
 * Component dialogs / modals — the spartan replacement for Ionic's
 * `ModalController`. `open()` mounts a component in a CDK dialog and returns the
 * {@link DialogRef}; the component closes itself with a result via
 * `inject(DialogRef).close(value)` (replacing `modalCtrl.dismiss(data)`), and the
 * opener reads that value with `openAndWait()` (replacing `onWillDismiss()`).
 * `inputs` map to the component's signal `input()`s (Ionic `componentProps`).
 */
@Injectable({ providedIn: 'root' })
export class TrnDialogService {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);

  open<R = unknown, C = object>(
    component: ComponentType<C>,
    opts: DialogOptions = {},
  ): DialogRef<R, C> {
    const ref = this.dialog.open<R, unknown, C>(component, {
      panelClass: opts.panelClass ?? 'trn-dialog-panel',
      backdropClass: ['cdk-overlay-dark-backdrop'],
      disableClose: opts.disableClose ?? false,
      data: opts.data,
      // Default (undefined) lets CDK center the card; `'end'` pins it top-right
      // and full-height (the panel's own h-screen fills the axis).
      positionStrategy:
        opts.side === 'end'
          ? this.overlay.position().global().top('0').right('0')
          : undefined,
    });
    if (opts.inputs && ref.componentRef) {
      for (const [key, value] of Object.entries(opts.inputs)) {
        ref.componentRef.setInput(key, value);
      }
    }
    return ref;
  }

  /** Open and resolve the component's close value (null if dismissed without one). */
  async openAndWait<R = unknown, C = object>(
    component: ComponentType<C>,
    opts: DialogOptions = {},
  ): Promise<R | null> {
    const ref = this.open<R, C>(component, opts);
    return (await firstValueFrom(ref.closed)) ?? null;
  }

  /**
   * Whether any dialog opened through here is currently presented — the
   * replacement for Ionic's `ModalController.getTop()` guard (e.g. "don't stack
   * the quick switcher over an open panel").
   */
  hasOpen(): boolean {
    return this.dialog.openDialogs.length > 0;
  }
}
