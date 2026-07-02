import { Injectable, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { firstValueFrom } from 'rxjs';
import {
  TrnAlertDialogComponent,
  type AlertDialogData,
} from './trn-alert-dialog.component';

export interface ConfirmOptions {
  header: string;
  message?: string;
  /** Confirm button label. Default 'OK'. */
  confirmText?: string;
  /** Cancel button label. Default 'Cancel'. */
  cancelText?: string;
  /** Style the confirm button as destructive (red). */
  destructive?: boolean;
}

export interface PromptOptions extends ConfirmOptions {
  placeholder?: string;
  /** Mask the input (e.g. for passwords). Default 'text'. */
  inputType?: 'text' | 'password';
  /** Initial input value. */
  value?: string;
  maxLength?: number;
}

/**
 * Confirm / prompt dialogs — the spartan replacement for Ionic's
 * `AlertController`. Opens {@link TrnAlertDialogComponent} in a CDK dialog (focus
 * trap, backdrop, escape-to-cancel) and resolves the user's choice, so call
 * sites read as `if (await alert.confirm(...))` / `const name = await
 * alert.prompt(...)` instead of Ionic's button-handler callbacks.
 */
@Injectable({ providedIn: 'root' })
export class TrnAlertService {
  private readonly dialog = inject(Dialog);

  /** Resolves true when confirmed, false on cancel / backdrop / escape. */
  async confirm(opts: ConfirmOptions): Promise<boolean> {
    const data: AlertDialogData = {
      kind: 'confirm',
      header: opts.header,
      message: opts.message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: opts.cancelText ?? 'Cancel',
      destructive: opts.destructive ?? false,
    };
    const ref = this.dialog.open<boolean>(TrnAlertDialogComponent, {
      data,
      backdropClass: ['cdk-overlay-dark-backdrop'],
    });
    return (await firstValueFrom(ref.closed)) ?? false;
  }

  /** Resolves the entered string, or null on cancel / backdrop / escape. */
  async prompt(opts: PromptOptions): Promise<string | null> {
    const data: AlertDialogData = {
      kind: 'prompt',
      header: opts.header,
      message: opts.message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: opts.cancelText ?? 'Cancel',
      destructive: opts.destructive ?? false,
      placeholder: opts.placeholder,
      inputType: opts.inputType,
      value: opts.value,
      maxLength: opts.maxLength,
    };
    const ref = this.dialog.open<string | null>(TrnAlertDialogComponent, {
      data,
      backdropClass: ['cdk-overlay-dark-backdrop'],
    });
    return (await firstValueFrom(ref.closed)) ?? null;
  }
}
