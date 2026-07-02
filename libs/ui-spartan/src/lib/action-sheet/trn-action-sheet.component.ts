import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { TrnButtonDirective } from '../button/hlm-button.directive';

export interface ActionSheetButton {
  text: string;
  role?: 'cancel' | 'destructive';
  handler?: () => void;
}

export interface ActionSheetData {
  header?: string;
  buttons: ActionSheetButton[];
}

/**
 * Bottom-sheet menu shown by {@link TrnActionSheetService}. Renders the buttons
 * as a stacked list; picking one closes the sheet, then runs its handler (a
 * non-cancel handler often opens another dialog). Replaces `<ion-action-sheet>`.
 */
@Component({
  selector: 'trn-action-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButtonDirective],
  template: `
    <div
      class="mb-3 w-[min(96vw,26rem)] overflow-hidden rounded-xl border border-solid border-border bg-card p-1.5 shadow-lg"
    >
      @if (data.header) {
        <p
          class="px-3 py-2 text-center text-xs font-medium text-muted-foreground"
        >
          {{ data.header }}
        </p>
      }
      @for (button of data.buttons; track $index) {
        <button
          trnBtn
          variant="ghost"
          class="w-full justify-center"
          [class.text-destructive]="button.role === 'destructive'"
          (click)="onClick(button)"
        >
          {{ button.text }}
        </button>
      }
    </div>
  `,
})
export class TrnActionSheetComponent {
  protected readonly data = inject<ActionSheetData>(DIALOG_DATA);
  private readonly ref =
    inject<DialogRef<void, TrnActionSheetComponent>>(DialogRef);

  protected onClick(button: ActionSheetButton): void {
    this.ref.close();
    if (button.role !== 'cancel') {
      button.handler?.();
    }
  }
}
