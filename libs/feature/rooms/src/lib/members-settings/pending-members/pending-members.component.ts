import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import { EmptyStateComponent } from '@trinity/components/generic-content';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  RoomActionPermissionsService,
  RoomModerationService,
  type ActionAvailability,
  type KnockRequest,
  type MemberSummary,
} from '@trinity/data-access/room-administration';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { filter, finalize, type Observable } from 'rxjs';

type PendingPerson = KnockRequest | MemberSummary;

/** Requests to join (Approve/Deny) or pending invites (Revoke) for one exact Room or Space. */
@Component({
  selector: 'trn-pending-members',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pending-members.component.html',
  imports: [EmptyStateComponent, TrnButton],
})
export class PendingMembersComponent {
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly moderation = inject(RoomModerationService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  /** User IDs with an action in flight; the sync echo removes the row itself. */
  private readonly busy = signal<ReadonlyMap<string, 'approve' | 'kick'>>(
    new Map(),
  );

  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly kind = input.required<'requests' | 'invited'>();
  readonly people = input.required<readonly PendingPerson[]>();
  /** Re-read on every change so permission checks follow live room state. */
  readonly authorityRevision = input(0);

  reason(person: PendingPerson): string | null {
    return 'reason' in person ? person.reason : null;
  }

  pending(userId: string): 'approve' | 'kick' | null {
    return this.busy().get(userId) ?? null;
  }

  canApprove(): ActionAvailability {
    this.authorityRevision();
    return this.permissions.roomFor(this.key()).invite;
  }

  canKick(userId: string): ActionAvailability {
    this.authorityRevision();
    return this.permissions.member(this.key(), userId).kick;
  }

  approve(person: PendingPerson): void {
    if (!this.canApprove().available) return;
    this.run(
      person.userId,
      'approve',
      this.rooms.inviteUser(this.key(), person.userId),
      `Couldn't approve ${person.roomDisplayName}'s request.`,
    );
  }

  deny(person: PendingPerson): void {
    this.confirmKick(
      person,
      `Deny ${person.roomDisplayName}'s request?`,
      'They can ask to join again later.',
      'Deny',
      `Couldn't deny ${person.roomDisplayName}'s request.`,
    );
  }

  revoke(person: PendingPerson): void {
    this.confirmKick(
      person,
      `Revoke ${person.roomDisplayName}'s invite?`,
      "They won't be able to join with this invite.",
      'Revoke',
      `Couldn't revoke ${person.roomDisplayName}'s invite.`,
    );
  }

  private key(): { accountId: string; roomId: string } {
    return { accountId: this.accountId(), roomId: this.roomId() };
  }

  private confirmKick(
    person: PendingPerson,
    header: string,
    message: string,
    confirmText: string,
    failure: string,
  ): void {
    if (!this.canKick(person.userId).available) return;
    this.alert
      .prompt$({
        header,
        message,
        confirmText,
        variant: 'danger',
        placeholder: 'Reason (optional)',
      })
      .pipe(
        filter((reason): reason is string => reason !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((reason) =>
        this.run(
          person.userId,
          'kick',
          this.moderation.kick(this.key(), person.userId, reason || undefined),
          failure,
        ),
      );
  }

  private run(
    userId: string,
    kind: 'approve' | 'kick',
    action: Observable<unknown>,
    failure: string,
  ): void {
    if (this.pending(userId)) return;
    this.busy.update((map) => new Map(map).set(userId, kind));
    action
      .pipe(
        finalize(() =>
          this.busy.update((map) => {
            const next = new Map(map);
            next.delete(userId);
            return next;
          }),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: () =>
          this.toast.show(failure, { duration: 4000, variant: 'danger' }),
      });
  }
}
