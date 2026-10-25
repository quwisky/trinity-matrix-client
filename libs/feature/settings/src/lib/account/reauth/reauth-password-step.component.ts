import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormField, FormRoot, form, required } from '@angular/forms/signals';
import {
  TrnButton,
  TrnInput,
  TrnLabel,
  TrnPasswordInputComponent,
} from '@trinity/components/controls';
import { TrnDialogActions } from '@trinity/components/overlay';

/** A dialog step that asks for the account's password to re-authenticate. */
@Component({
  selector: 'trn-reauth-password-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reauth-password-step.component.html',
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnDialogActions,
    TrnInput,
    TrnLabel,
    TrnPasswordInputComponent,
  ],
})
export class ReauthPasswordStepComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly credentials = signal({ password: '' });

  protected readonly passwordForm = form(this.credentials, (path) => {
    required(path.password);
  });
  protected readonly fieldId = computed(
    () => `${this.testIdPrefix()}-password`,
  );

  /** Prefixes the ids and test ids, so a dialog keeps its own. */
  readonly testIdPrefix = input.required<string>();
  readonly body = input.required<string>();
  readonly rejected = input(false);
  readonly rejectedMessage = input.required<string>();
  readonly submitLabel = input.required<string>();

  readonly submitted = output<string>();
  readonly back = output<void>();

  protected submit(): void {
    if (this.passwordForm().invalid()) {
      this.host.nativeElement
        .querySelector<HTMLElement>(`#${this.fieldId()}`)
        ?.focus();
      return;
    }
    const { password } = this.credentials();
    this.passwordForm().reset({ password: '' });
    this.submitted.emit(password);
  }
}
