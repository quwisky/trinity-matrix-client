import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/helm/overlay';
import { ReactionPickerComponent } from './reaction-picker.component';

/**
 * Presents {@link ReactionPickerComponent} as a dialog and resolves the chosen emoji
 * (or `null` when dismissed). Mirrors {@link UserPickerService}: it owns presentation
 * only, the caller sends the reaction with the returned emoji.
 */
@Injectable({ providedIn: 'root' })
export class ReactionPickerService {
  private readonly dialog = inject(TrnDialogService);

  /** Open the full emoji picker; resolves the selected emoji, or null if cancelled. */
  pick(): Promise<string | null> {
    return this.dialog.openAndWait<string, ReactionPickerComponent>(
      ReactionPickerComponent,
      {},
    );
  }
}
