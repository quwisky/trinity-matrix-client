import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { TrnActionSheetService } from '../../../action-sheet/trn-action-sheet.service';
import { TrnAlertService } from '../../../alert/trn-alert.service';
import { TrnToasterComponent } from '../../../toast/trn-toaster.component';
import { TrnToastService } from '../../../toast/trn-toast.service';

@Component({
  selector: 'trn-feedback-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnToasterComponent],
  templateUrl: './feedback-overlay-story.component.html',
})
export class FeedbackOverlayStoryComponent {
  private readonly alerts = inject(TrnAlertService);
  private readonly sheets = inject(TrnActionSheetService);
  private readonly toasts = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected neutralAlert(): void {
    this.alerts
      .confirm$({
        header: 'Keep this room?',
        message: 'The neutral confirmation path.',
        confirmText: 'Keep',
        variant: 'neutral',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected canonicalAlert(): void {
    this.alerts
      .confirm$({
        header: 'Delete this room?',
        confirmText: 'Delete',
        variant: 'danger',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected canonicalPrompt(): void {
    this.alerts
      .prompt$({
        header: 'Name this room',
        message: 'Prompt fields keep their label and bounded input options.',
        inputLabel: 'Room name',
        placeholder: 'Project room',
        value: 'Trinity',
        maxLength: 64,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected canonicalSheet(): void {
    this.sheets.open(
      {
        header: 'Canonical actions',
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          { text: 'Archive', disabled: true, testId: 'sheet-disabled' },
          {
            text: 'Delete',
            variant: 'danger',
            separatorBefore: true,
            testId: 'sheet-danger',
          },
        ],
        reactions: [{ key: '👍', handler: () => undefined }],
      },
      'Canonical actions',
    );
  }

  protected neutralToast(): void {
    this.toasts.show('Canonical neutral', { duration: 0 });
  }

  protected successToast(): void {
    this.toasts.show('Canonical success', {
      variant: 'success',
      duration: 0,
    });
  }

  protected warningToast(): void {
    this.toasts.show('Canonical warning', { variant: 'warning', duration: 0 });
  }

  protected dangerToast(): void {
    this.toasts.show('Canonical danger', { variant: 'danger', duration: 0 });
  }

  protected actionToast(): void {
    this.toasts.show('Canonical action', {
      duration: 0,
      action: { label: 'Undo', onClick: () => undefined },
    });
  }
}
