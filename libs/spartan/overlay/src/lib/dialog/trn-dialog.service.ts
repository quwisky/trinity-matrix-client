import { Injectable, inject } from '@angular/core';
import { Dialog, DialogConfig, DialogRef } from '@angular/cdk/dialog';
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
  ): DialogRef<R, C> {
    const ref = this.dialog.open<R, unknown, C>(component, {
      panelClass: opts.panelClass ?? 'trn-dialog-panel',
      backdropClass: ['cdk-overlay-dark-backdrop'],
      disableClose: opts.disableClose ?? false,
      data: opts.data,
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
