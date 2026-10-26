import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnButton } from '@trinity/components/controls';
import {
  AvatarComponent,
  EmptyStateComponent,
} from '@trinity/components/generic-content';
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
  imports: [AvatarComponent, EmptyStateComponent, TrnButton],
})
export class PendingMembersComponent {
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly moderation = inject(RoomModerationService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /** User IDs with an action in flight; the sync echo removes the row itself. */
  private readonly busy = signal<ReadonlyMap<string, 'approve' | 'kick'>>(
    new Map(),
  );
  /** A handled row whose sync echo hasn't removed it yet; focus moves on once it has. */
  private leaving: { readonly userId: string; readonly index: number } | null =
    null;
  private readonly _refocusWhenRowLeaves = effect(() => {
    this.people();
    this.refocusIfLeft();
  });

  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly kind = input.required<'requests' | 'invited'>();
  readonly people = input.required<readonly PendingPerson[]>();
  /** Re-read on every change so permission checks follow live room state. */
  readonly authorityRevision = input(0);
  /** The last row left after an action; the owner moves focus out of the empty list. */
  readonly listEmptied = output<void>();

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
    const failure = `Couldn't approve ${person.roomDisplayName}'s request.`;
    if (!this.stillPending(person.userId, failure)) return;
    this.run(
      person.userId,
      'approve',
      this.rooms.inviteUser(this.key(), person.userId),
      failure,
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
      .subscribe((reason) => {
        if (!this.stillPending(person.userId, failure)) return;
        this.run(
          person.userId,
          'kick',
          this.moderation.kick(this.key(), person.userId, reason || undefined),
          failure,
        );
      });
  }

  private run(
    userId: string,
    kind: 'approve' | 'kick',
    action: Observable<unknown>,
    failure: string,
  ): void {
    if (this.pending(userId)) return;
    const index = this.people().findIndex((person) => person.userId === userId);
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
        next: () => {
          this.leaving = { userId, index };
          this.refocusIfLeft();
        },
        error: () => this.fail(failure),
      });
  }

  /**
   * Whether the person is still in this list's live snapshot (knocking for Requests, invited for
   * Invited). Someone approved, denied or who accepted elsewhere has left it, and acting on them
   * now would kick a joined member.
   */
  private stillPending(userId: string, failure: string): boolean {
    if (this.people().some((person) => person.userId === userId)) return true;
    this.fail(failure);
    return false;
  }

  private fail(message: string): void {
    this.toast.show(message, { duration: 4000, variant: 'danger' });
  }

  private refocusIfLeft(): void {
    const leaving = this.leaving;
    const people = this.people();
    if (!leaving || people.some((person) => person.userId === leaving.userId))
      return;
    this.leaving = null;
    afterNextRender(
      () => {
        const active = this.host.nativeElement.ownerDocument.activeElement;
        // Only recover focus the removed row took with it; never steal it from elsewhere.
        if (active && active !== active.ownerDocument.body) return;
        if (people.length === 0) {
          this.listEmptied.emit();
          return;
        }
        const rows = this.host.nativeElement.querySelectorAll('li');
        const next = rows[Math.min(leaving.index, people.length - 1)];
        next?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
      },
      { injector: this.injector },
    );
  }
}
