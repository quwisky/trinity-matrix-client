import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, of, switchMap } from 'rxjs';
import { HlmButton } from '@trinity/helm/button';
import { TrnDialogRef } from '@trinity/helm/overlay';
import { ProfileService, PresenceService } from '@trinity/data-access/profile';
import { AvatarComponent } from '@trinity/ui';
import { initialOf } from '@trinity/util/matrix';

/**
 * A small profile card for a user (avatar, name, id, online status), shown when a
 * mention is clicked. It doesn't open a conversation itself: the "Message" button
 * closes the dialog resolving the user id so the host opens (or reuses) a DM.
 */
@Component({
  selector: 'trn-user-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, HlmButton],
  templateUrl: './user-card.component.html',
  styleUrl: './user-card.component.scss',
})
export class UserCardComponent {
  readonly userId = input.required<string>();

  private readonly dialogRef =
    inject<TrnDialogRef<string | null>>(TrnDialogRef);
  private readonly profileSvc = inject(ProfileService);
  private readonly presence = inject(PresenceService);

  /** The user's fetched profile (null while loading, or on an unresolved fetch). */
  readonly profile = toSignal(
    toObservable(this.userId).pipe(
      switchMap((id) =>
        this.profileSvc.fetch(id).pipe(catchError(() => of(null))),
      ),
    ),
    { initialValue: null },
  );

  /** Display name, falling back to the user id when unset. */
  readonly displayName = computed(
    () => this.profile()?.displayName || this.userId(),
  );
  readonly initial = computed(() => initialOf(this.displayName()));
  /** Live online status for the presence dot. */
  readonly presenceState = computed(() =>
    this.presence.presenceFor(this.userId())(),
  );

  /** Start (or reuse) a direct message with this user — the host does the navigation. */
  message(): void {
    this.dialogRef.close(this.userId());
  }

  close(): void {
    this.dialogRef.close(null);
  }
}
