import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { UserPickerComponent } from './user-picker.component';

/** Heading / labels for a {@link UserPickerService.pick} presentation. */
export interface UserPickerOptions {
  title: string;
  confirmLabel: string;
  placeholder?: string;
}

/**
 * Presents the {@link UserPickerComponent} as a {@link TrnDialogService} dialog and
 * resolves the chosen Matrix ID (or `null` when cancelled). Wraps the dialog so the
 * rooms page stays thin and the presentation can be retargeted later — mirroring
 * the thread panel. The page performs the actual create/invite with the
 * returned id, so this service owns presentation only.
 */
@Injectable({ providedIn: 'root' })
export class UserPickerService {
  private readonly dialog = inject(TrnDialogService);

  /** Open the picker; resolves the selected MXID, or null if cancelled/dismissed. */
  pick(options: UserPickerOptions): Promise<string | null> {
    return this.dialog.openAndWait<string, UserPickerComponent>(
      UserPickerComponent,
      {
        ariaLabel: options.title,
        inputs: {
          title: options.title,
          confirmLabel: options.confirmLabel,
          ...(options.placeholder ? { placeholder: options.placeholder } : {}),
        },
      },
    );
  }
}
