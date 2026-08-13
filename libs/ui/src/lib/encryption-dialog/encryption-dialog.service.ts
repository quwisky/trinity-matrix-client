import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type { Type } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
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
  /**
   * Open the flow already offering the recovery-key reset, for a caller whose own label
   * promised it. Without this a second entry point lands the user on "Enter your recovery
   * key" and asks them to find an identically-labelled button and press it again.
   */
  offerReset?: boolean;
}

/** The rooms shell's md breakpoint: at/above this the sidebar is a static column
 * rather than an overlay drawer, so the encryption flows present as a dialog. */
const DESKTOP_QUERY = '(min-width: 768px)';

/**
 * Presents the self-initiated encryption flows — recovery-key unlock
 * (`/encryption/unlock`) and device verification (`/encryption/verify`) — as a
 * CDK dialog on wide layouts (desktop/Electron) and as a routed page on
 * narrow/mobile layouts. The desktop-vs-mobile decision lives here in one
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
  private readonly dialog = inject(TrnDialogService);
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
      const component = (await load()) as Type<unknown>;
      // Force the in-dialog Close control: a backdrop/escape tap must not leave an
      // in-flight verification dangling, so the page owns clean teardown.
      this.dialog.open(component, {
        // Only when asked: `verify` has no such input, and setInput rejects one it
        // does not declare.
        inputs: {
          asModal: true,
          ...(opts?.offerReset ? { offerReset: true } : {}),
        },
        disableClose: true,
        ariaLabel: 'Encryption',
      });
      return;
    }
    const queryParams = {
      ...(opts?.returnTo ? { returnTo: opts.returnTo } : {}),
      ...(opts?.offerReset ? { reset: 1 } : {}),
    };
    await this.router.navigate(
      [path],
      Object.keys(queryParams).length ? { queryParams } : {},
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
