import { DestroyRef, Injectable, inject, type Type } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  TrnDialogRef,
  TrnDialogService,
  TrnToastService,
} from '@trinity/components/overlay';
import { filter, finalize, take } from 'rxjs';
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
 * The routed flow remains the canonical native and deep-link presentation. Keeping the
 * in-app policy here means every entry point behaves consistently without importing the
 * settings feature into the shared shell or composer.
 */
@Injectable({ providedIn: 'root' })
export class SettingsDialogService {
  private readonly router = inject(Router);
  private readonly dialog = inject(TrnDialogService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly config = inject(SETTINGS_DIALOG_CONFIG, { optional: true });

  private active?: TrnDialogRef<unknown>;
  private pending?: Promise<void>;
  private navigationGeneration = 0;

  constructor() {
    // A chunk can finish after logout or another deliberate navigation. No dialog exists
    // yet for CDK's close-on-navigation behavior to dismiss, so invalidate the pending
    // presentation ourselves rather than opening Settings over the destination page.
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationStart),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.navigationGeneration++);
  }

  open(options: OpenSettingsOptions = {}): Promise<void> {
    if (!this.config?.shouldPresentAsDialog()) {
      return this.navigate(options);
    }
    if (this.active) return Promise.resolve();
    if (this.pending) return this.pending;

    const task = this.present(
      this.config,
      options,
      this.navigationGeneration,
    ).finally(() => {
      if (this.pending === task) this.pending = undefined;
    });
    this.pending = task;
    return task;
  }

  private async present(
    config: SettingsDialogConfig,
    options: OpenSettingsOptions,
    navigationGeneration: number,
  ): Promise<void> {
    let component: Type<unknown>;
    try {
      component = await config.load();
    } catch {
      if (navigationGeneration === this.navigationGeneration) {
        this.showOpenFailure();
        this.restoreOwner(options, navigationGeneration);
      }
      return;
    }
    if (navigationGeneration !== this.navigationGeneration || this.active) {
      return;
    }

    const inputs = {
      ...(options.section ? { initialSection: options.section } : {}),
      ...(options.roomId ? { initialSource: options.roomId } : {}),
    };
    try {
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
            this.restoreOwner(options, navigationGeneration);
          }),
        )
        .subscribe();
    } catch {
      this.showOpenFailure();
      this.restoreOwner(options, navigationGeneration);
    }
  }

  private restoreOwner(
    options: OpenSettingsOptions,
    navigationGeneration: number,
  ): void {
    if (
      options.restoreFocus &&
      navigationGeneration === this.navigationGeneration
    ) {
      queueMicrotask(options.restoreFocus);
    }
  }

  private showOpenFailure(): void {
    this.toast.show('Could not open Settings. Please try again.', {
      duration: 5000,
      variant: 'destructive',
    });
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
