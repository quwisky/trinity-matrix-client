import { Injectable, inject } from '@angular/core';
import { TrnDialogService } from '@trinity/components/overlay';
import { defer, filter, take, type Observable } from 'rxjs';
import { ReactionPickerComponent } from './reaction-picker.component';

/**
 * Presents {@link ReactionPickerComponent} as a dialog and emits the chosen emoji. Dismissal
 * completes without a value. Mirrors {@link UserPickerService}: it owns presentation only,
 * while the caller sends the reaction with the returned emoji.
 */
@Injectable({ providedIn: 'root' })
export class ReactionPickerService {
  private readonly dialog = inject(TrnDialogService);

  /** Cold finite command opening the full picker and emitting only a chosen emoji. */
  pick$(): Observable<string> {
    return defer(() =>
      this.dialog.openAndWait$<string, ReactionPickerComponent>(
        ReactionPickerComponent,
        // Names the CDK container, which IS the dialog here. It had no accessible name at
        // all before, so a screen reader announced the most-used picker in the app as
        // "dialog"; the wrapper inside deliberately claims no role of its own.
        { ariaLabel: 'Pick a reaction' },
      ),
    ).pipe(
      filter((key): key is string => key !== null),
      take(1),
    );
  }
}
