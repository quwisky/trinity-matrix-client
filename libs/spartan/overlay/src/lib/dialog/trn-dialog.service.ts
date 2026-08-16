import { Injectable, inject } from '@angular/core';
import { Dialog, DialogConfig, DialogRef } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import type { ComponentType } from '@angular/cdk/portal';
import { firstValueFrom } from 'rxjs';
import { TrnDialogRef } from './trn-dialog-ref';

export interface DialogOptions {
  /** Set on the opened component as @Inputs after creation (Ionic componentProps). */
  inputs?: Record<string, unknown>;
  /**
   * Where the panel sits. `'center'` (default) is a centered modal card;
   * `'end'` pins it full-height against the inline-end (right) edge — the
   * split-pane side panel (the panel supplies its own width/height). Replaces the
   * Ionic `justify-content: flex-end` modal css.
   */
  side?: 'center' | 'end';
  /** Prevent backdrop/escape close (Ionic backdropDismiss: false). */
  disableClose?: boolean;
  /**
   * Accessible name announced when the dialog opens — CDK renders role="dialog"
   * with no name otherwise, so screen readers just say "dialog". Pass the dialog's
   * visible title (e.g. its `<h2>` text).
   */
  ariaLabel?: string;
  /**
   * Which element takes focus when the dialog opens, defaulting to CDK's
   * `'first-tabbable'`. That default is wrong for any dialog whose header carries a
   * Cancel/Close button ahead of the field the user came to type in — the button wins.
   * A component-side `focus()` can't fix it either: CDK focuses *after* attach, so it
   * simply overrides the earlier call. Name the element instead — a CSS selector
   * (`'[data-autofocus]'`), `'first-heading'`, `'dialog'` or `false`.
   */
  autoFocus?: DialogConfig['autoFocus'];
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
  ): TrnDialogRef<R> {
    // No `panelClass`. The option and its `trn-dialog-panel` default were both dead: no
    // call site ever passed one, and the class name occurred exactly once in the whole
    // workspace — here, styled by nothing. Same reason `DialogOptions.data` went in #151.
    // Every dialog paints its own surface (see the `dialog-surface()` mixin), so there is
    // no shared panel styling for a hook to carry. Re-add it with a real consumer.
    const ref = this.dialog.open<R, unknown, C>(component, {
      backdropClass: ['cdk-overlay-dark-backdrop'],
      disableClose: opts.disableClose ?? false,
      ariaLabel: opts.ariaLabel,
      // Spelled out rather than left off: CDK merges the config over its defaults with
      // a spread, so an `autoFocus: undefined` key would clobber the default instead of
      // falling back to it.
      autoFocus: opts.autoFocus ?? 'first-tabbable',
      // Default (undefined) lets CDK center the card; `'end'` pins it top-right
      // and full-height (the panel's own h-screen fills the axis).
      positionStrategy:
        opts.side === 'end'
          ? this.overlay.position().global().top('0').right('0')
          : undefined,
      // What lets a modal'd component `inject(TrnDialogRef)` instead of CDK's own class.
      // Declared with an explicit `deps` rather than an `inject()` call in the factory,
      // because `DialogConfig.providers` is typed `StaticProvider[]`.
      providers: [
        {
          provide: TrnDialogRef,
          useFactory: (cdkRef: DialogRef<R, unknown>) =>
            new TrnDialogRef<R>(cdkRef),
          deps: [DialogRef],
        },
      ],
    });
    if (opts.inputs && ref.componentRef) {
      for (const [key, value] of Object.entries(opts.inputs)) {
        ref.componentRef.setInput(key, value);
      }
    }
    return new TrnDialogRef<R>(ref);
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
   * Whether any overlay is currently presented — the replacement for Ionic's
   * `ModalController.getTop()` guard (e.g. "don't stack the quick switcher over an
   * open panel").
   *
   * This reads CDK's shared root stack, so it counts alerts and action sheets too,
   * not only dialogs opened through {@link open}. That is deliberate and always has
   * been true — the JSDoc used to claim otherwise. `Dialog` is `providedIn: 'root'`,
   * so {@link TrnAlertService} and {@link TrnActionSheetService} push onto the same
   * `openDialogs`, and a guard that ignored them would let a dialog stack on top of
   * an alert.
   */
  hasOpen(): boolean {
    return this.dialog.openDialogs.length > 0;
  }

  /**
   * Close the most recently opened overlay, returning whether one actually closed.
   *
   * This is the hardware back-button primitive: Android's back should dismiss what
   * is on top before it navigates. It closes the *last* entry of the shared stack
   * described on {@link hasOpen} — so back dismisses an alert or action sheet just
   * as it dismisses a dialog, and dismisses them in the order the user sees them.
   *
   * **`disableClose` is honoured here, and it has to be.** CDK does not do it for us:
   * `DialogRef.close()` gates only on `closePredicate`, so a programmatic close
   * dismisses a dialog that was explicitly opened as non-dismissible. Without this
   * guard the back button walked straight through the encryption-unlock and
   * device-verification dialogs, whose whole reason for setting the flag is that a
   * stray dismissal must not be possible mid-flow.
   *
   * A `false` return means "nothing closed", NOT "nothing was there" — the two are
   * distinguished by {@link hasOpen}, and a caller that navigates on `false` alone
   * would navigate underneath a modal still on screen. The back-button handler in
   * the app shell branches on `hasOpen()` for exactly that reason.
   *
   * Named rather than exposing CDK's `Dialog`: handing feature code the class back
   * would let it call `open()` with unmediated config, and this service would stop
   * being the only door.
   */
  closeTopmost(): boolean {
    const before = this.dialog.openDialogs.length;
    const top = this.dialog.openDialogs.at(-1);
    if (top?.disableClose) {
      return false;
    }
    top?.close();
    // Whether one actually CLOSED, not whether one was found. CDK's `close()` consults
    // the dialog's `closePredicate` and can decline; when it does close it splices the
    // ref out of `openDialogs` synchronously, so the lengths tell them apart. Reporting
    // a refusal as success would make the back button swallow the press while the dialog
    // stayed on screen — the one outcome worse than either branch on its own.
    return this.dialog.openDialogs.length < before;
  }

  /**
   * Close every open overlay. Intended for teardown — a spec that opened a real
   * dialog, or a flow that navigates away from everything at once.
   */
  closeAll(): void {
    this.dialog.closeAll();
  }
}
