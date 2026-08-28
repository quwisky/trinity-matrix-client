import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TrnDialogRef, TrnDialogService } from '@trinity/components/overlay';
import { finalize, take } from 'rxjs';
import {
  SETTINGS_DIALOG_CONFIG,
  type SettingsDialogConfig,
} from './settings-dialog.tokens';

export interface OpenSettingsOptions {
  /** Open a specific section instead of the settings directory. */
  section?: string;
  /** Prefill the sticker-pack manager with a room or account source. */
  roomId?: string;
  /** Restore a logical owner when the original overlay control no longer exists. */
  restoreFocus?: () => void;
}

/**
 * Opens account settings as a modal on web/Electron and as a route in native apps.
 *
 * The routed flow remains the canonical deep-link and lazy-load fallback. Keeping the
 * policy here means every entry point behaves consistently without importing the settings
 * feature into the shared shell or composer.
 */
@Injectable({ providedIn: 'root' })
export class SettingsDialogService {
  private readonly router = inject(Router);
  private readonly dialog = inject(TrnDialogService);
  private readonly config = inject(SETTINGS_DIALOG_CONFIG, { optional: true });

  private active?: TrnDialogRef<unknown>;
  private pending?: Promise<void>;

  open(options: OpenSettingsOptions = {}): Promise<void> {
    if (!this.config?.shouldPresentAsDialog()) {
      return this.navigate(options);
    }
    if (this.active) return Promise.resolve();
    if (this.pending) return this.pending;

    const task = this.present(this.config, options).finally(() => {
      if (this.pending === task) this.pending = undefined;
    });
    this.pending = task;
    return task;
  }

  private async present(
    config: SettingsDialogConfig,
    options: OpenSettingsOptions,
  ): Promise<void> {
    try {
      const component = await config.load();
      if (this.active) return;

      const inputs = {
        ...(options.section ? { initialSection: options.section } : {}),
        ...(options.roomId ? { initialSource: options.roomId } : {}),
      };
      const ref = this.dialog.open(component, {
        inputs,
        ariaLabel: 'Settings',
        autoFocus: '[data-settings-autofocus]',
      });
      this.active = ref;
      ref.closed
        .pipe(
          take(1),
          finalize(() => {
            if (this.active === ref) this.active = undefined;
            if (options.restoreFocus) queueMicrotask(options.restoreFocus);
          }),
        )
        .subscribe();
    } catch {
      await this.navigate(options);
    }
  }

  private async navigate(options: OpenSettingsOptions): Promise<void> {
    const path = options.section
      ? ['/settings', options.section]
      : ['/settings'];
    await this.router.navigate(
      path,
      options.roomId ? { queryParams: { roomId: options.roomId } } : {},
    );
  }
}
