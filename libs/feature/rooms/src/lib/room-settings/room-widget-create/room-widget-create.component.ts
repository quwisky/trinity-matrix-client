import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormField, form, submit, validate } from '@angular/forms/signals';
import { TrnButton } from '@trinity/components/controls';
import { TrnInput } from '@trinity/components/controls';
import { TrnLabel } from '@trinity/components/controls';
import { TrnToastService } from '@trinity/components/overlay';
import {
  WidgetManagementError,
  WidgetManagementService,
  type WidgetDraftFailure,
  validateRoomWidgetDraft,
} from '@trinity/data-access/widgets';
import { firstValueFrom } from 'rxjs';

interface WidgetDraftModel {
  name: string;
  rawUrl: string;
}

const EMPTY_DRAFT: WidgetDraftModel = { name: '', rawUrl: '' };

@Component({
  selector: 'trn-room-widget-create',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormField, TrnButton, TrnInput, TrnLabel],
  templateUrl: './room-widget-create.component.html',
  styleUrl: './room-widget-create.component.scss',
})
export class RoomWidgetCreateComponent {
  readonly roomId = input.required<string>();

  private readonly management = inject(WidgetManagementService);
  private readonly toast = inject(TrnToastService);
  private readonly model = signal<WidgetDraftModel>({ ...EMPTY_DRAFT });
  private readonly nameInput =
    viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly urlInput =
    viewChild<ElementRef<HTMLInputElement>>('urlInput');
  readonly requestError = signal<string | null>(null);

  readonly form = form(this.model, (path) => {
    validate(path.name, ({ value }) =>
      validationError(
        validateRoomWidgetDraft({
          name: value(),
          rawUrl: 'https://widgets.example',
        }).failure,
        'name',
      ),
    );
    validate(path.rawUrl, ({ value }) =>
      validationError(
        validateRoomWidgetDraft({ name: 'Widget', rawUrl: value() }).failure,
        'rawUrl',
      ),
    );
  });

  /** Submit through Signal Forms so validation and duplicate suppression share one path. */
  async add(): Promise<void> {
    this.requestError.set(null);
    await submit(this.form, {
      action: async (field) => {
        try {
          await firstValueFrom(
            this.management.create(this.roomId(), field().value()),
          );
          this.form().reset({ ...EMPTY_DRAFT });
          this.toast.show('Widget added.', {
            duration: 3000,
            variant: 'success',
          });
          this.focusName();
          return undefined;
        } catch (error) {
          this.requestError.set(managementFailureText(error));
          return undefined;
        }
      },
      onInvalid: () => this.focusFirstInvalid(),
    });
  }

  /** Treat Enter like the Add button, except while an IME is composing text. */
  onEnter(event: Event): void {
    if ((event as KeyboardEvent).isComposing) {
      return;
    }
    event.preventDefault();
    void this.add();
  }

  focusName(): void {
    queueMicrotask(() => this.nameInput()?.nativeElement.focus());
  }

  nameError(): string | null {
    return this.form.name().touched()
      ? (this.form.name().errors()[0]?.message ?? null)
      : null;
  }

  urlError(): string | null {
    return this.form.rawUrl().touched()
      ? (this.form.rawUrl().errors()[0]?.message ?? null)
      : null;
  }

  serverError(): string | null {
    return this.requestError();
  }

  private focusFirstInvalid(): void {
    const target = this.form.name().invalid()
      ? this.nameInput()
      : this.urlInput();
    target?.nativeElement.focus();
  }
}

function validationError(
  failure: WidgetDraftFailure | null,
  field: keyof WidgetDraftModel,
): { kind: WidgetDraftFailure; message: string } | undefined {
  if (!failure) {
    return undefined;
  }
  const belongsToName = failure.startsWith('name-');
  if ((field === 'name') !== belongsToName) {
    return undefined;
  }
  return { kind: failure, message: draftFailureText(failure) };
}

function draftFailureText(failure: WidgetDraftFailure): string {
  switch (failure) {
    case 'name-required':
      return 'Enter a widget name.';
    case 'name-too-long':
      return 'Use at most 128 characters.';
    case 'url-required':
      return 'Enter the widget URL.';
    case 'url-too-long':
      return 'The URL is too long.';
    case 'invalid-url':
      return 'Enter a complete URL.';
    case 'https-required':
      return 'Use an HTTPS URL.';
    case 'credentials':
      return 'Remove the username or password from the URL.';
    case 'dynamic-origin':
      return 'The widget origin cannot contain Matrix variables.';
  }
}

function managementFailureText(error: unknown): string {
  if (error instanceof WidgetManagementError) {
    switch (error.code) {
      case 'forbidden':
        return 'You no longer have permission to add widgets.';
      case 'uuid-unavailable':
      case 'uuid-collision':
        return 'Could not create a safe widget identifier. Try again.';
      case 'invalid-draft':
        return error.draftFailure
          ? draftFailureText(error.draftFailure)
          : 'Check the widget details and try again.';
      default:
        break;
    }
  }
  return 'Could not add the widget. Try again.';
}
