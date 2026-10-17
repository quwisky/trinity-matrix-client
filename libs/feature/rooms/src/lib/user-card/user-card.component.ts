import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, of, switchMap } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDialogRef,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import {
  IdentityPresenceService,
  IdentityService,
} from '@trinity/data-access/identity';
import { AvatarComponent } from '@trinity/components/generic-content';
import { initialOf } from '@trinity/util/matrix';

/**
 * A small profile card for a user (avatar, name, id, online status), shown when a
 * mention is clicked. It doesn't open a conversation itself: the "Message" button
 * closes the dialog resolving the user id so the host opens (or reuses) a DM.
 */
@Component({
  selector: 'trn-user-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, TrnButton, TrnOverlaySurfaceDirective],
  templateUrl: './user-card.component.html',
  styleUrl: './user-card.component.scss',
})
export class UserCardComponent {
  readonly userId = input.required<string>();

  private readonly dialogRef =
    inject<TrnDialogRef<string | null>>(TrnDialogRef);
  private readonly profileSvc = inject(IdentityService);
  private readonly presence = inject(IdentityPresenceService);

  readonly profile = toSignal(
    toObservable(this.userId).pipe(
      switchMap((id) =>
        this.profileSvc.lookup(id).pipe(catchError(() => of(null))),
      ),
    ),
    { initialValue: null },
  );

  readonly displayName = computed(
    () => this.profile()?.displayName || this.userId(),
  );
  readonly initial = computed(() => initialOf(this.displayName()));
  readonly presenceState = computed(() =>
    this.presence.presenceFor(this.userId())(),
  );

  message(): void {
    this.dialogRef.close(this.userId());
  }

  close(): void {
    this.dialogRef.close(null);
  }
}
