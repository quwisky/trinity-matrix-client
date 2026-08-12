import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { TrnButton } from '@trinity/kit/button';
import { TrnInput } from '@trinity/kit/input';

/** Payload for {@link TrnAlertDialogComponent}, built by TrnAlertService. */
export interface AlertDialogData {
  kind: 'confirm' | 'prompt';
  header: string;
  message?: string;
  confirmText: string;
  cancelText: string;
  destructive: boolean;
  placeholder?: string;
  inputLabel?: string;
  value?: string;
  maxLength?: number;
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
  imports: [TrnButton, TrnInput],
  template: `
    <div
      class="w-[min(90vw,26rem)] rounded-lg border border-solid border-border bg-card p-6 text-card-foreground shadow-lg"
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
          [attr.maxlength]="data.maxLength ?? null"
          [value]="value()"
          (input)="onInput($event)"
          (keydown.enter)="onConfirm()"
        />
      }
      <div class="mt-6 flex justify-end gap-2">
        <button
          trnBtn
          variant="outline"
          (click)="onCancel()"
          data-testid="alert-cancel"
        >
          {{ data.cancelText }}
        </button>
        <button
          trnBtn
          [variant]="data.destructive ? 'destructive' : 'default'"
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
  protected readonly data = inject<AlertDialogData>(DIALOG_DATA);
  private readonly ref =
    inject<DialogRef<AlertDialogResult, TrnAlertDialogComponent>>(DialogRef);
  protected readonly value = signal(this.data.value ?? '');

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  protected onCancel(): void {
    this.ref.close(this.data.kind === 'prompt' ? null : false);
  }

  protected onConfirm(): void {
    this.ref.close(this.data.kind === 'prompt' ? this.value() : true);
  }
}
