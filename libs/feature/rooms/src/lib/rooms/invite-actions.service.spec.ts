import { TestBed } from '@angular/core/testing';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  InvitesService,
  type PendingInvite,
} from '@trinity/data-access/room-library';
import { MockProvider } from 'ng-mocks';
import { EMPTY, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomLinkPreviewComponent } from '../room-link-preview/room-link-preview.component';
import { AccountRoutingService } from './account-routing.service';
import { InviteActionsService } from './invite-actions.service';
import { ShellStatusService } from './shell-status.service';
import { ReportService } from '../report/report.service';

const invite: PendingInvite = {
  roomId: '!inv:hs',
  accountId: '@work:hs',
  name: 'Book club',
  initial: 'B',
  avatarMxc: null,
  inviterName: 'Ann',
  inviterId: '@ann:hs',
  isSpace: false,
  isDirect: false,
};

function setup(result: unknown) {
  const openAndWait$ = vi.fn(() => of(result));
  const onSelectRoomSelection = vi.fn();
  const openConfirmedLinkedRoom = vi.fn();
  const declineAndReport$ = vi.fn(() => of('declined' as const));
  TestBed.configureTestingModule({
    providers: [
      InviteActionsService,
      MockProvider(TrnSurfaceService, { openAndWait$ } as never),
      MockProvider(AccountRoutingService, {
        onSelectRoomSelection,
        openConfirmedLinkedRoom,
      } as never),
      MockProvider(ShellStatusService),
      MockProvider(InvitesService),
      MockProvider(ReportService, { declineAndReport$ }),
    ],
  });
  return {
    svc: TestBed.inject(InviteActionsService),
    openAndWait$,
    onSelectRoomSelection,
    openConfirmedLinkedRoom,
    declineAndReport$,
  };
}

describe('InviteActionsService.onPreviewInvite', () => {
  it('previews the invited room as the invited account', () => {
    const { svc, openAndWait$ } = setup(null);
    svc.onPreviewInvite(invite);
    expect(openAndWait$).toHaveBeenCalledWith(
      RoomLinkPreviewComponent,
      expect.objectContaining({
        inputs: {
          target: { kind: 'room', roomIdOrAlias: '!inv:hs' },
          accountId: '@work:hs',
        },
      }),
    );
  });

  it('opens the room once the preview accepted the invite', () => {
    const { svc, onSelectRoomSelection } = setup({
      accountId: '@work:hs',
      roomId: '!inv:hs',
      isSpace: false,
      membershipChanged: true,
    });
    svc.onPreviewInvite(invite);
    expect(onSelectRoomSelection).toHaveBeenCalledWith(
      { roomId: '!inv:hs', accountId: '@work:hs' },
      'room-invitation',
    );
  });

  it('opens a direct message with the direct-invitation origin', () => {
    const { svc, onSelectRoomSelection } = setup({ membershipChanged: true });
    svc.onPreviewInvite({ ...invite, isDirect: true });
    expect(onSelectRoomSelection).toHaveBeenCalledWith(
      { roomId: '!inv:hs', accountId: '@work:hs' },
      'direct-invitation',
    );
  });

  // Through the confirmed path, which waits for the join to sync before selecting it.
  it('opens an accepted space as the invited account', () => {
    const { svc, onSelectRoomSelection, openConfirmedLinkedRoom } = setup({
      membershipChanged: true,
    });
    svc.onPreviewInvite({ ...invite, isSpace: true });
    expect(openConfirmedLinkedRoom).toHaveBeenCalledWith({
      kind: 'space',
      roomId: '!inv:hs',
      accountId: '@work:hs',
    });
    expect(onSelectRoomSelection).not.toHaveBeenCalled();
  });

  it('opens the room when the invite was already accepted elsewhere', () => {
    const { svc, onSelectRoomSelection } = setup({
      accountId: '@work:hs',
      roomId: '!inv:hs',
      isSpace: false,
      membershipChanged: false,
    });
    svc.onPreviewInvite(invite);
    expect(onSelectRoomSelection).toHaveBeenCalledWith(
      { roomId: '!inv:hs', accountId: '@work:hs' },
      'room-invitation',
    );
  });

  it('stays put when the preview is closed without accepting', () => {
    const { svc, onSelectRoomSelection } = setup(null);
    svc.onPreviewInvite(invite);
    expect(onSelectRoomSelection).not.toHaveBeenCalled();
  });
});

describe('InviteActionsService.onDeclineAndReport', () => {
  it('reports and declines as the invited account, naming the inviter', () => {
    const { svc, declineAndReport$ } = setup(null);

    svc.onDeclineAndReport(invite);

    expect(declineAndReport$).toHaveBeenCalledExactlyOnceWith({
      accountId: '@work:hs',
      roomId: '!inv:hs',
      inviterId: '@ann:hs',
      inviterName: 'Ann',
    });
  });

  it('announces when the answer has finished, declined or not', () => {
    const { svc, declineAndReport$ } = setup(null);
    const answered: unknown[] = [];
    svc.answered.subscribe((a) => answered.push(a));

    svc.onDeclineAndReport(invite);
    declineAndReport$.mockReturnValueOnce(EMPTY as never);
    svc.onDeclineAndReport(invite);

    expect(answered).toEqual([
      { roomId: '!inv:hs', declined: true },
      { roomId: '!inv:hs', declined: false },
    ]);
  });
});
