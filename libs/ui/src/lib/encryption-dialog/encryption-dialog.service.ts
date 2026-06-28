import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ModalController } from '@ionic/angular/standalone';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  type EncryptionDialogKind,
} from './encryption-dialog.tokens';

/** Options shared by the encryption dialog entry points. */
export interface EncryptionDialogOptions {
  /**
   * Where to return after the routed (mobile) flow finishes. Ignored in modal
   * mode, where dismissing the modal simply reveals the underlying view.
   */
  returnTo?: string;
}

/** Centered auto-height card for the desktop modals (see global.scss). */
const MODAL_CSS_CLASS = 'encryption-dialog-modal';

/** Matches `<ion-split-pane when="md">` in the rooms shell (Ionic `md` = 768px). */
const DESKTOP_QUERY = '(min-width: 768px)';

/**
 * Presents the self-initiated encryption flows — recovery-key unlock
 * (`/encryption/unlock`) and device verification (`/encryption/verify`) — as an
 * Ionic modal on the wide split-pane layout (desktop/Electron) and as a routed
 * page on narrow/mobile layouts. The desktop-vs-mobile decision lives here in one
 * place ({@link isDesktopLayout}) so it can be retargeted (e.g. Electron-only)
 * without touching callers.
 *
 * The page components are resolved lazily through {@link ENCRYPTION_DIALOG_COMPONENTS}
 * (wired at the app via dynamic imports of feature-crypto's pages) so this service
 * stays in `ui` and never imports the feature directly. When the loaders are absent
 * (no app wiring, or `ui` in isolation) it falls back to routing — so the routes
 * remain the canonical deep-link / fallback target.
 */
@Injectable({ providedIn: 'root' })
export class EncryptionDialogService {
  private readonly router = inject(Router);
  private readonly modalCtrl = inject(ModalController);
  private readonly components = inject(ENCRYPTION_DIALOG_COMPONENTS, {
    optional: true,
  });

  /** Recover this device from a saved recovery key (flow B). */
  openUnlock(opts?: EncryptionDialogOptions): Promise<void> {
    return this.open('unlock', '/encryption/unlock', opts);
  }

  /** Verify this device against another signed-in session (emoji SAS). */
  openVerify(opts?: EncryptionDialogOptions): Promise<void> {
    return this.open('verify', '/encryption/verify', opts);
  }

  private async open(
    kind: EncryptionDialogKind,
    path: string,
    opts?: EncryptionDialogOptions,
  ): Promise<void> {
    const load = this.components?.[kind];
    if (load && this.isDesktopLayout()) {
      const component = await load();
      const modal = await this.modalCtrl.create({
        component,
        componentProps: { asModal: true },
        cssClass: MODAL_CSS_CLASS,
        // Force the in-modal Close control: a backdrop tap must not leave an
        // in-flight verification dangling, so the page owns clean teardown.
        backdropDismiss: false,
      });
      await modal.present();
      return;
    }
    await this.router.navigate(
      [path],
      opts?.returnTo ? { queryParams: { returnTo: opts.returnTo } } : {},
    );
  }

  /**
   * True on the wide split-pane layout (the same `md` breakpoint as the rooms
   * shell; Electron is always wide). Feature-detects `matchMedia` so SSR /
   * non-DOM contexts fall back to the routed flow.
   */
  private isDesktopLayout(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(DESKTOP_QUERY).matches
    );
  }
}
