import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { FormField, form, required } from '@angular/forms/signals';
import { TrnButton, TrnInput } from '@trinity/components/controls';
import type { TrnAlertVariant } from './trn-alert.service';
import { TrnOverlaySurfaceDirective } from '../surface/trn-overlay-surface.directive';

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
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, TrnButton, TrnInput, TrnOverlaySurfaceDirective],
  template: `
    <div
      trnOverlaySurface
      variant="neutral"
      size="md"
      layout="dialog"
      class="p-6"
      data-testid="alert-surface"
    >
      <h2 class="text-lg leading-none font-semibold tracking-tight">
        {{ data.header }}
      </h2>
      @if (data.message) {
        <p class="mt-2 text-sm whitespace-pre-line text-muted-foreground">
          {{ data.message }}
        </p>
      }
      @if (data.kind === 'prompt') {
        <input
          trnInput
          class="mt-4"
          [type]="data.inputType ?? 'text'"
          [placeholder]="data.placeholder ?? ''"
          [attr.aria-label]="data.inputLabel ?? null"
          [attr.aria-describedby]="promptInvalid() ? promptErrorId : null"
          [attr.aria-invalid]="promptInvalid() ? 'true' : null"
          [attr.maxlength]="data.maxLength ?? null"
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
      <div class="mt-6 flex justify-end gap-2">
        <button
          trnBtn
          variant="secondary"
          presentation="outline"
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
    </div>
  `,
})
export class TrnAlertDialogComponent {
  private readonly ref =
    inject<DialogRef<AlertDialogResult, TrnAlertDialogComponent>>(DialogRef);
  private readonly dialogData = inject<AlertDialogData>(DIALOG_DATA);
  private readonly promptModel = signal({ value: this.dialogData.value ?? '' });
  protected readonly data = this.dialogData;
  protected readonly promptForm = form(this.promptModel, (path) => {
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
