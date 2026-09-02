import { Injectable, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import type { TrnVariant } from '@trinity/components/foundations';
import { defer, map, take, type Observable } from 'rxjs';
import {
  TrnAlertDialogComponent,
  type AlertDialogData,
} from './trn-alert-dialog.component';

export type TrnAlertVariant = Extract<TrnVariant, 'neutral' | 'danger'>;

export interface ConfirmOptions {
  header: string;
  /**
   * Body copy. Newlines are preserved and render as separate paragraphs, so a message
   * whose parts must be read one at a time can be joined with `\n\n`.
   */
  message?: string;
  /** Confirm button label. Default 'OK'. */
  confirmText?: string;
  /** Cancel button label. Default 'Cancel'. */
  cancelText?: string;
  /** Semantic treatment for the confirmation action. */
  variant?: TrnAlertVariant;
}

export interface PromptOptions extends ConfirmOptions {
  placeholder?: string;
  /**
   * Accessible name for the input. A placeholder is not one — it vanishes on the first
   * keystroke and assistive tech is not obliged to announce it — so any prompt whose
   * expected input is not obvious from the header should set this.
   */
  inputLabel?: string;
  /** Mask the input (e.g. for passwords). Default 'text'. */
  inputType?: 'text' | 'password';
  /** Initial input value. */
  value?: string;
  maxLength?: number;
  /** Keep the prompt open and announce an error until a non-empty value is entered. */
  required?: boolean;
}

/**
 * Confirm / prompt dialogs — the spartan replacement for Ionic's
 * `AlertController`. Opens {@link TrnAlertDialogComponent} in a CDK dialog (focus
 * trap, backdrop, escape-to-cancel) and exposes cold finite RxJS commands for
 * the user's choice.
 */
@Injectable({ providedIn: 'root' })
export class TrnAlertService {
  private readonly dialog = inject(Dialog);

  /** Emits true when confirmed, false on cancel / backdrop / escape. */
  confirm$(opts: ConfirmOptions): Observable<boolean> {
    const data: AlertDialogData = {
      kind: 'confirm',
      header: opts.header,
      message: opts.message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: opts.cancelText ?? 'Cancel',
      variant: opts.variant ?? 'neutral',
    };
    return defer(() => {
      const ref = this.dialog.open<boolean>(TrnAlertDialogComponent, {
        data,
        ariaLabel: data.header,
        backdropClass: ['cdk-overlay-dark-backdrop'],
      });
      return ref.closed.pipe(
        take(1),
        map((value) => value ?? false),
      );
    });
  }

  /** Emits the entered string, or null on cancel / backdrop / escape. */
  prompt$(opts: PromptOptions): Observable<string | null> {
    const data: AlertDialogData = {
      kind: 'prompt',
      header: opts.header,
      message: opts.message,
      confirmText: opts.confirmText ?? 'OK',
      cancelText: opts.cancelText ?? 'Cancel',
      variant: opts.variant ?? 'neutral',
      placeholder: opts.placeholder,
      inputLabel: opts.inputLabel,
      inputType: opts.inputType,
      value: opts.value,
      maxLength: opts.maxLength,
      required: opts.required,
    };
    return defer(() => {
      const ref = this.dialog.open<string | null>(TrnAlertDialogComponent, {
        data,
        ariaLabel: data.header,
        backdropClass: ['cdk-overlay-dark-backdrop'],
      });
      return ref.closed.pipe(
        take(1),
        map((value) => value ?? null),
      );
    });
  }
}
