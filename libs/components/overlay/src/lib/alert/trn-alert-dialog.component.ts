import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { FormField, form, maxLength, required } from '@angular/forms/signals';
import { TrnButton, TrnInput } from '@trinity/components/controls';
import type { TrnAlertVariant } from './trn-alert.service';
import {
  TrnDialogActions,
  TrnDialogShellComponent,
} from '../dialog-shell/trn-dialog-shell.component';

/** Payload for {@link TrnAlertDialogComponent}, built by TrnAlertService. */
export interface AlertDialogData {
  kind: 'confirm' | 'prompt';
  header: string;
  message?: string;
  confirmText: string;
  cancelText: string;
  variant: TrnAlertVariant;
  placeholder?: string;
  inputLabel?: string;
  value?: string;
  maxLength?: number;
  required?: boolean;
  inputType?: 'text' | 'password';
}

/** Result: a confirm resolves boolean; a prompt resolves the string or null. */
export type AlertDialogResult = boolean | string | null;

/**
 * The card shown inside a CDK dialog for {@link TrnAlertService}'s confirm/prompt.
 * Closes the {@link DialogRef} with the result; a backdrop/escape dismiss closes
 * with `undefined`, which the service maps to cancel. Replaces `<ion-alert>`.
 */
@Component({
  selector: 'trn-alert-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    TrnButton,
    TrnDialogActions,
    TrnDialogShellComponent,
    TrnInput,
  ],
  template: `
    <trn-dialog-shell
      [title]="data.header"
      [description]="data.message"
      [closable]="false"
      data-testid="alert-surface"
    >
      @if (data.kind === 'prompt') {
        <input
          trnInput
          [type]="data.inputType ?? 'text'"
          [placeholder]="data.placeholder ?? ''"
          [attr.aria-label]="data.inputLabel ?? null"
          [attr.aria-describedby]="promptInvalid() ? promptErrorId : null"
          [attr.aria-invalid]="promptInvalid() ? 'true' : null"
          [formField]="promptForm.value"
          (keydown.enter)="onConfirm()"
        />
        @if (promptInvalid()) {
          <p
            [id]="promptErrorId"
            class="mt-2 text-sm text-danger"
            role="alert"
            data-testid="alert-prompt-error"
          >
            {{ promptError() }}
          </p>
        }
      }
      <div trnDialogActions>
        <button
          trnBtn
          variant="secondary"
          presentation="link"
          (click)="onCancel()"
          data-testid="alert-cancel"
        >
          {{ data.cancelText }}
        </button>
        <button
          trnBtn
          [variant]="data.variant === 'danger' ? 'danger' : 'primary'"
          [attr.data-trn-variant]="data.variant"
          (click)="onConfirm()"
          data-testid="alert-confirm"
        >
          {{ data.confirmText }}
        </button>
      </div>
    </trn-dialog-shell>
  `,
})
export class TrnAlertDialogComponent {
  private readonly ref =
    inject<DialogRef<AlertDialogResult, TrnAlertDialogComponent>>(DialogRef);
  private readonly dialogData = inject<AlertDialogData>(DIALOG_DATA);
  private readonly promptModel = signal({ value: this.dialogData.value ?? '' });
  protected readonly data = this.dialogData;
  protected readonly promptForm = form(this.promptModel, (path) => {
    maxLength(path.value, () => this.data.maxLength, {
      message: `${this.data.inputLabel ?? 'This value'} must be ${this.data.maxLength} characters or fewer.`,
    });
    required(path.value, {
      message: `${this.data.inputLabel ?? 'This value'} is required.`,
      when: () => this.data.required === true,
    });
  });
  protected readonly promptInvalid = computed(
    () =>
      this.promptForm.value().touched() && this.promptForm.value().invalid(),
  );
  protected readonly promptError = computed(
    () => this.promptForm.value().errors()[0]?.message ?? '',
  );
  protected readonly promptErrorId = 'trn-alert-prompt-error';

  protected onCancel(): void {
    this.ref.close(this.data.kind === 'prompt' ? null : false);
  }

  protected onConfirm(): void {
    if (this.data.kind === 'prompt') {
      this.promptForm.value().markAsTouched();
      if (this.promptForm().invalid()) return;
    }
    this.ref.close(
      this.data.kind === 'prompt' ? this.promptModel().value : true,
    );
  }
}
