import { computed, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { WorkspaceNavigationService } from '@trinity/application/workspace';
import {
  RoomMembersService,
  type MemberSummary,
} from '@trinity/data-access/room-administration';
import {
  RoomLibraryService,
  type RoomSummary,
} from '@trinity/data-access/room-library';
import { TrustUsersService, type UserTrust } from '@trinity/data-access/trust';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { RoomIdentityChangesService } from './room-identity-changes.service';

const KEY = { accountId: '@me:hs', roomId: '!r:hs' };

const person = (userId: string, name: string): MemberSummary => ({
  userId,
  roomDisplayName: name,
  roomInitial: name[0] ?? '?',
  roomAvatarMxc: null,
  powerLevel: 0,
  isCreator: false,
});

describe('RoomIdentityChangesService', () => {
  let trust: Map<string, WritableSignal<UserTrust | null>>;
  let encrypted: WritableSignal<boolean>;
  let active: WritableSignal<string | null>;
  let joined: WritableSignal<readonly MemberSummary[]>;
  let invited: WritableSignal<readonly MemberSummary[]>;

  beforeEach(() => {
    trust = new Map();
    encrypted = signal(true);
    active = signal<string | null>('@me:hs');
    joined = signal([
      person('@me:hs', 'Me'),
      person('@alice:hs', 'Alice'),
      person('@bob:hs', 'Bob'),
    ]);
    invited = signal([person('@carol:hs', 'Carol')]);
    TestBed.configureTestingModule({
      providers: [
        MockProvider(WorkspaceNavigationService, { activeAccountId: active }),
        MockProvider(RoomLibraryService, {
          rooms: computed(() => [
            { id: '!r:hs', encrypted: encrypted() } as RoomSummary,
          ]),
        }),
        MockProvider(RoomMembersService, {
          membersFor: () => joined,
          invitedFor: () => invited,
        }),
        MockProvider(TrustUsersService, {
          userTrust: (userId: string) => {
            let state = trust.get(userId);
            if (!state) {
              state = signal<UserTrust | null>('unverified');
              trust.set(userId, state);
            }
            return state;
          },
        }),
      ],
    });
  });

  const changes = () => TestBed.inject(RoomIdentityChangesService).changes(KEY);

  it('lists joined and invited members whose identity changed, never yourself', () => {
    const service = TestBed.inject(RoomIdentityChangesService);
    service.changes(KEY);
    trust.get('@me:hs')?.set('identity-changed');
    trust.get('@bob:hs')?.set('verified-identity-changed');
    trust.get('@carol:hs')?.set('identity-changed');

    expect(service.changes(KEY)).toEqual([
      {
        userId: '@bob:hs',
        name: 'Bob',
        initial: 'B',
        avatarMxc: null,
        trust: 'verified-identity-changed',
      },
      {
        userId: '@carol:hs',
        name: 'Carol',
        initial: 'C',
        avatarMxc: null,
        trust: 'identity-changed',
      },
    ]);
  });

  it('drops a member once their identity is acknowledged', () => {
    changes();
    trust.get('@alice:hs')?.set('identity-changed');
    expect(changes().map((c) => c.userId)).toEqual(['@alice:hs']);

    trust.get('@alice:hs')?.set('unverified');
    expect(changes()).toEqual([]);
  });

  it('is empty for an unencrypted room', () => {
    encrypted.set(false);
    changes();
    trust.get('@alice:hs')?.set('identity-changed');

    expect(changes()).toEqual([]);
  });

  it("is empty for another account's room, whose trust is not read here", () => {
    active.set('@other:hs');

    expect(changes()).toEqual([]);
    expect(trust.size).toBe(0);
  });
});
