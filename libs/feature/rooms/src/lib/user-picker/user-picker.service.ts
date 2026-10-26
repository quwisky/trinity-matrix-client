import { Injectable, inject } from '@angular/core';
import { TrnSurfaceService } from '@trinity/components/overlay';
import { map, type Observable } from 'rxjs';
import {
  UserPickerComponent,
  type PickedUser,
  type UserPickerNote,
} from './user-picker.component';

export type { UserPickerNote } from './user-picker.component';

/** Heading / labels for a {@link UserPickerService.pick$} presentation. */
export interface UserPickerOptions {
  title: string;
  confirmLabel: string;
  placeholder?: string;
  note?: UserPickerNote | null;
}

/**
 * Presents the {@link UserPickerComponent} as a {@link TrnSurfaceService} dialog and resolves
 * the chosen Matrix ID, or `null` when cancelled. Presentation only: the page performs the
 * create/invite with the returned id.
 */
@Injectable({ providedIn: 'root' })
export class UserPickerService {
  private readonly dialog = inject(TrnSurfaceService);

  /** Open the picker; resolves the selected MXID, or null if cancelled/dismissed. */
  pick$(options: UserPickerOptions): Observable<string | null> {
    return this.pickUser$(options).pipe(map((user) => user?.userId ?? null));
  }

  /** Open the picker; resolves who was picked, with their name when known. */
  pickUser$(options: UserPickerOptions): Observable<PickedUser | null> {
    return this.dialog.openAndWait$<PickedUser, UserPickerComponent>(
      UserPickerComponent,
      {
        autoFocus: '[data-autofocus]',
        inputs: {
          title: options.title,
          confirmLabel: options.confirmLabel,
          ...(options.placeholder ? { placeholder: options.placeholder } : {}),
          ...(options.note ? { note: options.note } : {}),
        },
      },
    );
  }
}
