import { TestBed } from '@angular/core/testing';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  InvitesService,
  type PendingInvite,
} from '@trinity/data-access/room-library';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomLinkPreviewComponent } from '../room-link-preview/room-link-preview.component';
import { AccountRoutingService } from './account-routing.service';
import { InviteActionsService } from './invite-actions.service';
import { ShellStatusService } from './shell-status.service';

const invite: PendingInvite = {
  roomId: '!inv:hs',
  accountId: '@work:hs',
  name: 'Book club',
  initial: 'B',
  avatarMxc: null,
  inviterName: 'Ann',
  isSpace: false,
  isDirect: false,
};

function setup(result: unknown) {
  const openAndWait$ = vi.fn(() => of(result));
  const onSelectRoomSelection = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      InviteActionsService,
      MockProvider(TrnSurfaceService, { openAndWait$ } as never),
      MockProvider(AccountRoutingService, { onSelectRoomSelection } as never),
      MockProvider(ShellStatusService),
      MockProvider(InvitesService),
    ],
  });
  return {
    svc: TestBed.inject(InviteActionsService),
    openAndWait$,
    onSelectRoomSelection,
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

  it('stays put when the preview is closed without accepting', () => {
    const { svc, onSelectRoomSelection } = setup(null);
    svc.onPreviewInvite(invite);
    expect(onSelectRoomSelection).not.toHaveBeenCalled();
  });
});
