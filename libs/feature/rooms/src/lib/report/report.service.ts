import { Injectable, inject } from '@angular/core';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  IdentityService,
  IgnoredUsersService,
} from '@trinity/data-access/identity';
import {
  ContentReportError,
  ContentReportingService,
  RoomModerationService,
  type ReportKind,
  type RoomActionPermissionsKey,
} from '@trinity/data-access/room-administration';
import {
  InvitesService,
  RoomLibraryService,
} from '@trinity/data-access/room-library';
import {
  EMPTY,
  catchError,
  defer,
  finalize,
  map,
  of,
  switchMap,
  tap,
  type Observable,
} from 'rxjs';

/** A user to report, as the account that saw them. */
export interface ReportUserTarget {
  readonly accountId: string;
  readonly userId: string;
  /** What the person reporting calls them: display name, else the user ID. */
  readonly name: string;
}

/** An invite to decline and whose room to report, with who sent it. */
export interface DeclineAndReportTarget {
  readonly accountId: string;
  readonly roomId: string;
  readonly inviterId: string;
  readonly inviterName: string;
}

/** Whether an answered invite ended declined or is still pending. */
export type InviteAnswer = 'declined' | 'kept';

/** What happened after a room report was sent. */
export type RoomReportOutcome = 'reported' | 'left';

const REASON = {
  inputLabel: 'Reason (optional)',
  placeholder: 'Reason (optional)',
  maxLength: 1000,
} as const;
/** Shown once a block lands, from a report or from the member card. */
export const BLOCKED_TOAST = "Blocked — you won't see their messages.";
/** Shown when a block or unblock write fails. */
export const BLOCK_FAILED_TOAST = 'Could not update the block.';
/** Shown once an unblock lands. */
export const UNBLOCKED_TOAST = 'Unblocked.';

const NEXT_STEPS =
  "Your server's admins decide what happens next. They may not reply.";

/**
 * Reports to the reporter's own server admins: a message, a room or a user. Each flow prompts
 * for a reason, sends, then offers the obvious follow-up (leave the room, block the user) as
 * the confirmation itself. None of it needs room-admin rights.
 */
@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly moderation = inject(RoomModerationService);
  private readonly reporting = inject(ContentReportingService);
  private readonly rooms = inject(RoomLibraryService);
  private readonly invites = inject(InvitesService);
  private readonly ignoredUsers = inject(IgnoredUsersService);
  private readonly identity = inject(IdentityService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);

  /** Prompt for a reason and report `eventId` to the server admins. */
  report$(
    target: string | RoomActionPermissionsKey,
    eventId: string,
  ): Observable<void> {
    return defer(() => {
      const roomId = typeof target === 'string' ? target : target.roomId;
      if (!roomId || !eventId) {
        return EMPTY;
      }
      return this.alert
        .prompt$({
          header: 'Report message',
          message: "Report this message to your server's admins?",
          ...REASON,
          confirmText: 'Report',
          variant: 'danger',
        })
        .pipe(
          switchMap((reason) =>
            reason === null
              ? EMPTY
              : this.moderation.reportMessage(target, eventId, reason),
          ),
          tap(() =>
            this.toast.show("Reported to your server's admins.", {
              duration: 3000,
            }),
          ),
          map(() => undefined),
          catchError(() => {
            this.toast.show('Could not report the message.', {
              duration: 4000,
              variant: 'danger',
            });
            return EMPTY;
          }),
        );
    });
  }

  /**
   * Report a room, then offer to leave it. Emits once if the report was sent. `accountLabel`
   * names the account that would leave when several are shown together.
   */
  reportRoom$(
    target: RoomActionPermissionsKey,
    options: { readonly accountLabel?: string } = {},
  ): Observable<RoomReportOutcome> {
    const as = options.accountLabel ? ` as ${options.accountLabel}` : '';
    return this.alert
      .prompt$({
        header: 'Report room',
        message:
          "Your server's admins will see this report and your reason. The room's members won't be told.",
        ...REASON,
        confirmText: 'Report',
        variant: 'danger',
      })
      .pipe(
        switchMap((reason) =>
          reason === null
            ? EMPTY
            : this.reporting.reportRoom(target, reason).pipe(
                catchError((error: unknown) => this.failed(error, 'room')),
                switchMap(() =>
                  this.alert.confirm$({
                    header: 'Report sent',
                    message: `${NEXT_STEPS}\n\nIf you leave${as}, you'll need a new invite or a public join to come back.`,
                    confirmText: 'Leave room',
                    cancelText: 'Done',
                    variant: 'danger',
                  }),
                ),
                switchMap((leave) =>
                  leave
                    ? this.rooms.leave(target.roomId, target.accountId).pipe(
                        map((): RoomReportOutcome => 'left'),
                        catchError(() => {
                          this.toast.show('Could not leave the room.', {
                            duration: 4000,
                            variant: 'danger',
                          });
                          return of<RoomReportOutcome>('reported');
                        }),
                      )
                    : of<RoomReportOutcome>('reported'),
                ),
              ),
        ),
      );
  }

  /** Report a user, then offer to block them. Completes without emitting if nothing was sent. */
  reportUser$(target: ReportUserTarget): Observable<void> {
    return defer(() => {
      // isIgnored reads the projection, so hold it for the length of the flow.
      const ignoreList = this.ignoredUsers.runProjection().subscribe();
      return this.reportUserFlow(target).pipe(
        finalize(() => ignoreList.unsubscribe()),
      );
    });
  }

  private reportUserFlow(target: ReportUserTarget): Observable<void> {
    return this.alert
      .prompt$({
        header: `Report ${target.name}`,
        message:
          "Your server's admins will see this report and your reason. They won't be told.",
        ...REASON,
        confirmText: 'Report',
        variant: 'danger',
      })
      .pipe(
        switchMap((reason) =>
          reason === null
            ? EMPTY
            : this.reporting
                .reportUser(target.accountId, target.userId, reason)
                .pipe(
                  catchError((error: unknown) => this.failed(error, 'user')),
                  switchMap(() => this.offerBlock(target)),
                ),
        ),
      );
  }

  /**
   * Report an invited room, then decline the invite, without joining. If the report fails,
   * asks whether to decline anyway. Emits once: whether the invite was declined or kept.
   */
  declineAndReport$(invite: DeclineAndReportTarget): Observable<InviteAnswer> {
    const room = { accountId: invite.accountId, roomId: invite.roomId };
    return defer(() => {
      const ignoreList = this.ignoredUsers.runProjection().subscribe();
      // Accepted or declined elsewhere: the question no longer applies.
      const settled = this.invites.inviteSettled(room.roomId, room.accountId);
      return this.alert
        .prompt$({
          header: 'Report room',
          message:
            "Your server's admins will see this report and your reason. The room's members won't be told. The invite is declined.",
          ...REASON,
          confirmText: 'Decline and report',
          variant: 'danger',
          closeWhen: settled,
        })
        .pipe(
          switchMap((reason) =>
            reason === null
              ? EMPTY
              : this.reporting.reportRoom(room, reason).pipe(
                  map((): boolean | 'kept' => true),
                  catchError((error: unknown) =>
                    this.alert
                      .confirm$({
                        header: 'Report not sent',
                        message: `${reportFailureMessage(error, 'room')}\n\nDecline the invite anyway?`,
                        confirmText: 'Decline',
                        cancelText: 'Keep invite',
                        variant: 'danger',
                        closeWhen: settled,
                      })
                      .pipe(map((decline) => (decline ? false : 'kept'))),
                  ),
                ),
          ),
          switchMap((reported) =>
            reported === 'kept'
              ? of<InviteAnswer>('kept')
              : this.decline(invite, reported),
          ),
          finalize(() => ignoreList.unsubscribe()),
        );
    });
  }

  /** Decline unless the invite was accepted meanwhile; then offer to block the inviter. */
  private decline(
    invite: DeclineAndReportTarget,
    reported: boolean,
  ): Observable<InviteAnswer> {
    const sent = reported ? 'Report sent. ' : '';
    return this.invites.declineIfInvited(invite.roomId, invite.accountId).pipe(
      catchError(() => {
        this.toast.show(
          reported
            ? 'Report sent, but the invite could not be declined. Use Decline to try again.'
            : 'Could not decline the invitation. Try again.',
          { duration: 5000, variant: 'danger' },
        );
        return of('failed' as const);
      }),
      switchMap((result): Observable<InviteAnswer> => {
        if (result === 'failed') return of('kept');
        if (result === 'joined') {
          this.toast.show(
            `${sent}You joined this room on another device, so the invite wasn't declined.`,
            { duration: 5000 },
          );
          return of('kept');
        }
        return reported
          ? this.offerBlock(
              {
                accountId: invite.accountId,
                userId: invite.inviterId,
                name: invite.inviterName,
              },
              `${NEXT_STEPS} The invite was declined.`,
            ).pipe(map((): InviteAnswer => 'declined'))
          : of('declined');
      }),
    );
  }

  /** Blocking runs as the active account, so it is offered only when that is the reporter. */
  private offerBlock(
    target: ReportUserTarget,
    after = NEXT_STEPS,
  ): Observable<void> {
    if (
      !target.userId ||
      target.accountId !== this.identity.activeUserId() ||
      this.ignoredUsers.isIgnored(target.userId)
    ) {
      this.toast.show(`Report sent. ${after}`, { duration: 4000 });
      return of(undefined);
    }
    return this.alert
      .confirm$({
        header: 'Report sent',
        message: after,
        confirmText: `Block ${target.name}`,
        cancelText: 'Done',
        variant: 'danger',
      })
      .pipe(
        switchMap((block) =>
          block
            ? this.ignoredUsers.ignore(target.userId).pipe(
                tap(() => this.toast.show(BLOCKED_TOAST, { duration: 2500 })),
                catchError(() => {
                  this.toast.show(BLOCK_FAILED_TOAST, {
                    duration: 4000,
                    variant: 'danger',
                  });
                  return of(undefined);
                }),
              )
            : of(undefined),
        ),
      );
  }

  private failed(error: unknown, kind: ReportKind): Observable<never> {
    this.toast.show(reportFailureMessage(error, kind), {
      duration: 5000,
      variant: 'danger',
    });
    return EMPTY;
  }
}

function reportFailureMessage(error: unknown, kind: ReportKind): string {
  const failure =
    error instanceof ContentReportError ? error.failure : undefined;
  switch (failure?.kind) {
    case 'rate-limited': {
      if (failure.retryAfterMs === null) {
        return 'Too many reports right now. Try again shortly.';
      }
      const seconds = Math.max(1, Math.ceil(failure.retryAfterMs / 1000));
      return `Too many reports right now. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
    }
    case 'not-found':
      return `Your server doesn't know this ${kind}, so it can't take the report.`;
    case 'unsupported':
      return `Your server doesn't accept ${kind} reports.`;
    case 'reason-too-long':
      return 'That reason is too long. Shorten it and try again.';
    default:
      return "Couldn't send the report. Try again.";
  }
}
