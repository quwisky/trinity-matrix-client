import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnAlertService, TrnToastService } from '@trinity/components/overlay';
import {
  IdentityService,
  IgnoredUsersService,
} from '@trinity/data-access/identity';
import {
  ContentReportError,
  ContentReportingService,
  RoomModerationService,
  type ContentReportFailure,
} from '@trinity/data-access/room-administration';
import {
  InvitesService,
  RoomLibraryService,
} from '@trinity/data-access/room-library';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, lastValueFrom, of, throwError, toArray } from 'rxjs';
import { describe, expect, it, type Mock, vi } from 'vitest';
import { ReportService } from './report.service';

const ROOM = { accountId: '@me:hs', roomId: '!r:hs' };
const BOB = { accountId: '@me:hs', userId: '@bob:hs', name: 'Bob' };

function setup(
  over: {
    prompt$?: Mock;
    confirm$?: Mock;
    reportMessage?: Mock;
    reportRoom?: Mock;
    reportUser?: Mock;
    ignored?: boolean;
    activeUserId?: string;
    projection?: Subject<void>;
    declineIfInvited?: Mock;
    inviteSettled?: Mock;
  } = {},
) {
  const prompt$ = over.prompt$ ?? vi.fn(() => of('spam'));
  const confirm$ = over.confirm$ ?? vi.fn(() => of(false));
  const reportMessage = over.reportMessage ?? vi.fn(() => of(undefined));
  const reportRoom = over.reportRoom ?? vi.fn(() => of(undefined));
  const reportUser = over.reportUser ?? vi.fn(() => of(undefined));
  const leave = vi.fn(() => of(undefined));
  const declineIfInvited =
    over.declineIfInvited ?? vi.fn(() => of<'declined' | 'joined'>('declined'));
  const inviteSettled = over.inviteSettled ?? vi.fn(() => NEVER);
  const ignore = vi.fn(() => of(undefined));
  const ignoredRun = vi.fn(() => over.projection ?? new Subject<void>());
  const toastShow = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      ReportService,
      MockProvider(RoomModerationService, { reportMessage }),
      MockProvider(ContentReportingService, { reportRoom, reportUser }),
      MockProvider(RoomLibraryService, { leave }),
      MockProvider(InvitesService, { declineIfInvited, inviteSettled }),
      MockProvider(IgnoredUsersService, {
        isIgnored: () => over.ignored ?? false,
        runProjection: ignoredRun,
        ignore,
      }),
      MockProvider(IdentityService, {
        activeUserId: signal<string | null>(
          over.activeUserId ?? '@me:hs',
        ).asReadonly(),
      }),
      MockProvider(TrnAlertService, { prompt$, confirm$ }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    svc: TestBed.inject(ReportService),
    prompt$,
    confirm$,
    reportMessage,
    reportRoom,
    reportUser,
    leave,
    declineIfInvited,
    inviteSettled,
    ignore,
    ignoredRun,
    toastShow,
  };
}

const fails = (report: 'room' | 'user', failure: ContentReportFailure) =>
  vi.fn(() => throwError(() => new ContentReportError(report, failure)));

describe('ReportService', () => {
  describe('messages', () => {
    it('reports the message as the account that saw it', async () => {
      const { svc, reportMessage, toastShow, prompt$ } = setup();

      await lastValueFrom(svc.report$(ROOM, '$evt'));

      expect(reportMessage).toHaveBeenCalledWith(ROOM, '$evt', 'spam');
      expect(prompt$).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Report this message to your server's admins?",
          inputLabel: 'Reason (optional)',
          placeholder: 'Reason (optional)',
          maxLength: 1000,
        }),
      );
      expect(toastShow).toHaveBeenCalledWith(
        "Reported to your server's admins.",
        expect.anything(),
      );
    });

    it('does not report when the prompt is cancelled', async () => {
      const { svc, reportMessage } = setup({
        prompt$: vi.fn(() => of(null)),
      });

      await lastValueFrom(svc.report$(ROOM, '$evt'), {
        defaultValue: undefined,
      });

      expect(reportMessage).not.toHaveBeenCalled();
    });

    it('toasts an error when the report fails', async () => {
      const { svc, toastShow } = setup({
        reportMessage: vi.fn(() => throwError(() => new Error('nope'))),
      });

      await lastValueFrom(svc.report$(ROOM, '$evt'), {
        defaultValue: undefined,
      });

      expect(toastShow).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ variant: 'danger' }),
      );
    });

    it('does nothing without a room or event id', async () => {
      const { svc, prompt$ } = setup();

      await lastValueFrom(svc.report$({ ...ROOM, roomId: '' }, '$evt'), {
        defaultValue: undefined,
      });

      expect(prompt$).not.toHaveBeenCalled();
    });
  });

  describe('rooms', () => {
    it('asks for an optional reason and says who will see the report', async () => {
      const { svc, prompt$ } = setup({ prompt$: vi.fn(() => of(null)) });

      await lastValueFrom(svc.reportRoom$(ROOM), { defaultValue: undefined });

      expect(prompt$).toHaveBeenCalledWith({
        header: 'Report room',
        message:
          "Your server's admins will see this report and your reason. The room's members won't be told.",
        inputLabel: 'Reason (optional)',
        placeholder: 'Reason (optional)',
        maxLength: 1000,
        confirmText: 'Report',
        variant: 'danger',
      });
    });

    it('sends nothing when cancelled', async () => {
      const { svc, reportRoom, confirm$ } = setup({
        prompt$: vi.fn(() => of(null)),
      });

      const out = await lastValueFrom(svc.reportRoom$(ROOM).pipe(toArray()));

      expect(out).toEqual([]);
      expect(reportRoom).not.toHaveBeenCalled();
      expect(confirm$).not.toHaveBeenCalled();
    });

    it('sends an empty reason when none is given', async () => {
      const { svc, reportRoom } = setup({ prompt$: vi.fn(() => of('')) });

      await lastValueFrom(svc.reportRoom$(ROOM));

      expect(reportRoom).toHaveBeenCalledExactlyOnceWith(ROOM, '');
    });

    it('offers to leave in the confirmation, and leaves as the reporting account', async () => {
      const { svc, confirm$, leave } = setup({
        confirm$: vi.fn(() => of(true)),
      });

      const outcome = await lastValueFrom(svc.reportRoom$(ROOM));

      expect(confirm$).toHaveBeenCalledWith({
        header: 'Report sent',
        message:
          "Your server's admins decide what happens next. They may not reply.\n\nIf you leave, you'll need a new invite or a public join to come back.",
        confirmText: 'Leave room',
        cancelText: 'Done',
        variant: 'danger',
      });
      expect(leave).toHaveBeenCalledExactlyOnceWith('!r:hs', '@me:hs');
      expect(outcome).toBe('left');
    });

    it('names the account that would leave when accounts are mixed', async () => {
      const { svc, confirm$ } = setup();

      await lastValueFrom(
        svc.reportRoom$(ROOM, { accountLabel: 'Work (@me:hs)' }),
      );

      expect(confirm$).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Your server's admins decide what happens next. They may not reply.\n\nIf you leave as Work (@me:hs), you'll need a new invite or a public join to come back.",
        }),
      );
    });

    it('stays in the room on Done', async () => {
      const { svc, leave } = setup();

      const outcome = await lastValueFrom(svc.reportRoom$(ROOM));

      expect(leave).not.toHaveBeenCalled();
      expect(outcome).toBe('reported');
    });

    it.each<[ContentReportFailure, string]>([
      [
        { kind: 'rate-limited', retryAfterMs: 4200 },
        'Too many reports right now. Try again in 5 seconds.',
      ],
      [
        { kind: 'not-found' },
        "Your server doesn't know this room, so it can't take the report.",
      ],
      [{ kind: 'unsupported' }, "Your server doesn't accept room reports."],
      [
        { kind: 'reason-too-long' },
        'That reason is too long. Shorten it and try again.',
      ],
      [{ kind: 'failed' }, "Couldn't send the report. Try again."],
    ])('explains a %o failure', async (failure, message) => {
      const { svc, toastShow, confirm$ } = setup({
        reportRoom: fails('room', failure),
      });

      await lastValueFrom(svc.reportRoom$(ROOM), { defaultValue: undefined });

      expect(toastShow).toHaveBeenCalledWith(
        message,
        expect.objectContaining({ variant: 'danger' }),
      );
      expect(confirm$).not.toHaveBeenCalled();
    });
  });

  describe('users', () => {
    it('names the user and says they will not be told', async () => {
      const { svc, prompt$ } = setup({ prompt$: vi.fn(() => of(null)) });

      await lastValueFrom(svc.reportUser$(BOB), { defaultValue: undefined });

      expect(prompt$).toHaveBeenCalledWith(
        expect.objectContaining({
          header: 'Report Bob',
          message:
            "Your server's admins will see this report and your reason. They won't be told.",
        }),
      );
    });

    it('offers to block in the confirmation', async () => {
      const { svc, reportUser, confirm$, ignore } = setup({
        prompt$: vi.fn(() => of('harassment')),
        confirm$: vi.fn(() => of(true)),
      });

      await lastValueFrom(svc.reportUser$(BOB));

      expect(reportUser).toHaveBeenCalledExactlyOnceWith(
        '@me:hs',
        '@bob:hs',
        'harassment',
      );
      expect(confirm$).toHaveBeenCalledWith(
        expect.objectContaining({
          header: 'Report sent',
          confirmText: 'Block Bob',
          cancelText: 'Done',
        }),
      );
      expect(ignore).toHaveBeenCalledExactlyOnceWith('@bob:hs');
    });

    it('holds the ignore list while the flow runs, so "already blocked" is current', async () => {
      const projection = new Subject<void>();
      const { svc, ignoredRun } = setup({ projection });
      const flow = svc.reportUser$(BOB).subscribe();

      expect(ignoredRun).toHaveBeenCalled();
      flow.unsubscribe();
      expect(projection.observed).toBe(false);
    });

    it('confirms with a plain toast when they are already blocked', async () => {
      const { svc, confirm$, toastShow } = setup({ ignored: true });

      await lastValueFrom(svc.reportUser$(BOB));

      expect(confirm$).not.toHaveBeenCalled();
      expect(toastShow).toHaveBeenCalledWith(
        "Report sent. Your server's admins decide what happens next. They may not reply.",
        expect.anything(),
      );
    });

    it('does not offer to block as another account than the active one', async () => {
      const { svc, confirm$ } = setup({ activeUserId: '@other:hs' });

      await lastValueFrom(svc.reportUser$(BOB));

      expect(confirm$).not.toHaveBeenCalled();
    });

    it('explains that the server does not take user reports', async () => {
      const { svc, toastShow } = setup({
        reportUser: fails('user', { kind: 'unsupported' }),
      });

      await lastValueFrom(svc.reportUser$(BOB), { defaultValue: undefined });

      expect(toastShow).toHaveBeenCalledWith(
        "Your server doesn't accept user reports.",
        expect.objectContaining({ variant: 'danger' }),
      );
    });
  });

  describe('declining an invite and reporting the room', () => {
    const INVITE = {
      accountId: '@me:hs',
      roomId: '!spam:hs',
      inviterId: '@spammer:hs',
      inviterName: 'Spammer',
    };

    it('asks for a reason in the room report prompt, closing it if the invite moves on', async () => {
      const settled = new Subject<void>();
      const { svc, prompt$, reportRoom, declineIfInvited, inviteSettled } =
        setup({
          prompt$: vi.fn(() => of(null)),
          inviteSettled: vi.fn(() => settled),
        });

      const out = await lastValueFrom(
        svc.declineAndReport$(INVITE).pipe(toArray()),
      );

      expect(prompt$).toHaveBeenCalledWith({
        header: 'Report room',
        message:
          "Your server's admins will see this report and your reason. The room's members won't be told. The invite is declined.",
        inputLabel: 'Reason (optional)',
        placeholder: 'Reason (optional)',
        maxLength: 1000,
        confirmText: 'Decline and report',
        variant: 'danger',
        closeWhen: settled,
      });
      expect(inviteSettled).toHaveBeenCalledWith('!spam:hs', '@me:hs');
      expect(out).toEqual([]);
      expect(reportRoom).not.toHaveBeenCalled();
      expect(declineIfInvited).not.toHaveBeenCalled();
    });

    it('reports the room, then declines as the invited account', async () => {
      const calls: string[] = [];
      const reportRoom = vi.fn(() => {
        calls.push('report');
        return of(undefined);
      });
      const declineIfInvited = vi.fn(() => {
        calls.push('decline');
        return of(undefined);
      });
      const { svc } = setup({ reportRoom, declineIfInvited });

      const outcome = await lastValueFrom(svc.declineAndReport$(INVITE));

      expect(reportRoom).toHaveBeenCalledWith(
        { accountId: '@me:hs', roomId: '!spam:hs' },
        'spam',
      );
      expect(declineIfInvited).toHaveBeenCalledWith('!spam:hs', '@me:hs');
      expect(calls).toEqual(['report', 'decline']);
      expect(outcome).toBe('declined');
    });

    it('then offers to block the inviter', async () => {
      const { svc, confirm$, ignore } = setup({
        confirm$: vi.fn(() => of(true)),
      });

      await lastValueFrom(svc.declineAndReport$(INVITE));

      expect(confirm$).toHaveBeenCalledWith({
        header: 'Report sent',
        message:
          "Your server's admins decide what happens next. They may not reply. The invite was declined.",
        confirmText: 'Block Spammer',
        cancelText: 'Done',
        variant: 'danger',
      });
      expect(ignore).toHaveBeenCalledExactlyOnceWith('@spammer:hs');
    });

    it('asks whether to decline anyway when the report fails', async () => {
      const { svc, confirm$, declineIfInvited } = setup({
        reportRoom: fails('room', { kind: 'failed' }),
        confirm$: vi.fn(() => of(true)),
      });

      const outcome = await lastValueFrom(svc.declineAndReport$(INVITE));

      expect(confirm$).toHaveBeenCalledWith({
        header: 'Report not sent',
        message:
          "Couldn't send the report. Try again.\n\nDecline the invite anyway?",
        confirmText: 'Decline',
        cancelText: 'Keep invite',
        variant: 'danger',
        closeWhen: expect.anything(),
      });
      expect(declineIfInvited).toHaveBeenCalledWith('!spam:hs', '@me:hs');
      expect(outcome).toBe('declined');
    });

    it('keeps the invite when the person chooses to after a failed report', async () => {
      const { svc, declineIfInvited } = setup({
        reportRoom: fails('room', { kind: 'failed' }),
        confirm$: vi.fn(() => of(false)),
      });

      const outcome = await lastValueFrom(svc.declineAndReport$(INVITE));

      expect(declineIfInvited).not.toHaveBeenCalled();
      expect(outcome).toBe('kept');
    });

    it('says so when the decline itself fails after the report was sent', async () => {
      const { svc, toastShow } = setup({
        declineIfInvited: vi.fn(() => throwError(() => new Error('offline'))),
      });

      const outcome = await lastValueFrom(svc.declineAndReport$(INVITE));

      expect(toastShow).toHaveBeenCalledWith(
        'Report sent, but the invite could not be declined. Use Decline to try again.',
        expect.objectContaining({ variant: 'danger' }),
      );
      expect(outcome).toBe('kept');
    });
    it('never leaves a room the invited account joined meanwhile, and says so', async () => {
      const { svc, toastShow, confirm$ } = setup({
        declineIfInvited: vi.fn(() => of<'declined' | 'joined'>('joined')),
      });

      const outcome = await lastValueFrom(svc.declineAndReport$(INVITE));

      expect(outcome).toBe('kept');
      expect(toastShow).toHaveBeenCalledWith(
        "Report sent. You joined this room on another device, so the invite wasn't declined.",
        expect.anything(),
      );
      expect(confirm$).not.toHaveBeenCalled();
    });

    it('declines as the invited account and offers no Block while another account is active', async () => {
      const { svc, declineIfInvited, confirm$, toastShow } = setup({
        activeUserId: '@other:hs',
        confirm$: vi.fn(() => of(true)),
      });

      const outcome = await lastValueFrom(svc.declineAndReport$(INVITE));

      expect(declineIfInvited).toHaveBeenCalledExactlyOnceWith(
        '!spam:hs',
        '@me:hs',
      );
      expect(outcome).toBe('declined');
      expect(confirm$).not.toHaveBeenCalled();
      expect(toastShow).toHaveBeenCalledWith(
        "Report sent. Your server's admins decide what happens next. They may not reply. The invite was declined.",
        expect.anything(),
      );
    });
  });
});
