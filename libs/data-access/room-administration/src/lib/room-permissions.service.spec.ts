import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { KnownMembership } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomActionPermissionError } from './room-action-permissions.service';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import { RoomPermissionsService } from './room-permissions.service';
import { AdministeredRoomStore } from './administered-room.store';
import { administeredRoom } from './room-administration.spec-harness';

const ROOM = '!room:hs';
const HIGHER = 'Only someone with a higher role can change this';

function fixture(
  userId: string,
  options: {
    power?: number;
    content?: Record<string, unknown> | null;
    mayChange?: boolean;
  } = {},
) {
  const f = {
    content:
      options.content === undefined
        ? ({ kick: 50, ban: 100, users: { [userId]: 50 } } as Record<
            string,
            unknown
          > | null)
        : options.content,
    power: options.power ?? 50,
    mayChange: options.mayChange ?? true,
  };
  const sendStateEvent = vi.fn(() => Promise.resolve({ event_id: '$e' }));
  const state = {
    maySendStateEvent: () => f.mayChange,
    getStateEvents: () => (f.content ? { getContent: () => f.content } : null),
  };
  const room = {
    getMyMembership: () => KnownMembership.Join,
    getMember: () => ({ powerLevel: f.power }),
    getLiveTimeline: () => ({ getState: () => state }),
  };
  return {
    f,
    sendStateEvent,
    client: {
      getRoom: (id: string) => (id === ROOM ? room : null),
      getUserId: () => userId,
      sendStateEvent,
      on: vi.fn(),
      off: vi.fn(),
    },
  };
}

function setup(...fixtures: ReturnType<typeof fixture>[]) {
  const clients = new Map(
    fixtures.map((x) => [x.client.getUserId(), x] as const),
  );
  const store: Pick<AdministeredRoomStore, 'room' | 'members'> = {
    room: (accountId, roomId) => {
      const f = clients.get(accountId)?.f;
      return f
        ? administeredRoom(roomId, accountId, {
            ownPower: f.power === Infinity ? 'infinite' : f.power,
            // A threshold the power always or never meets.
            powerLevels: {
              events: { 'm.room.power_levels': f.mayChange ? 0 : 1e9 },
            },
          })
        : null;
    },
    members: () => null,
  };
  TestBed.configureTestingModule({
    providers: [
      MockProvider(MatrixClientService, {
        isInitialized: true,
        get instance() {
          return fixtures[0].client as never;
        },
        clientFor: (id: string) => (clients.get(id)?.client as never) ?? null,
        activeUserId: signal(fixtures[0].client.getUserId()).asReadonly(),
      }),
      { provide: AdministeredRoomStore, useValue: store },
    ],
  });
  const state = TestBed.inject(RoomAdministrationProjectionState);
  state.select(fixtures[0].client.getUserId(), ROOM);
  state.update('permissions', 'available', 'retained');
  return TestBed.inject(RoomPermissionsService);
}

const key = (accountId = '@me:hs') => ({ accountId, roomId: ROOM });
const row = (view: ReturnType<RoomPermissionsService['view']>, id: string) =>
  view.rows.find((r) => r.row.id === id)!;

describe('RoomPermissionsService', () => {
  it('view rows are editable up to my power', () => {
    const view = setup(fixture('@me:hs')).view(key(), 'room');

    expect(row(view, 'kick')).toMatchObject({ editable: true, reason: null });
    expect(row(view, 'ban')).toMatchObject({ editable: false, reason: HIGHER });
  });

  it('a v12 creator has no cap', () => {
    const view = setup(fixture('@me:hs', { power: Infinity })).view(
      key(),
      'room',
    );

    expect(view.myPower).toBe(Infinity);
    expect(view.rows.every((r) => r.editable)).toBe(true);
    expect(view.powerFromDefault).toBe(false);
  });

  it('read-only without permission to send power levels', () => {
    const view = setup(fixture('@me:hs', { mayChange: false })).view(
      key(),
      'room',
    );

    expect(view.editable).toBe(false);
    expect(view.reason).toBe(
      "Your role cannot change this room's permissions.",
    );
    expect(view.rows.some((r) => r.editable)).toBe(false);
  });

  it('names the space in the read-only reason by target kind', () => {
    const view = setup(fixture('@me:hs', { mayChange: false })).view(
      key(),
      'space',
    );

    expect(view.reason).toBe(
      "Your role cannot change this space's permissions.",
    );
  });

  it('read-only when the room has no power-levels event', async () => {
    const me = fixture('@me:hs', { content: null });
    const service = setup(me);

    expect(service.view(key(), 'room')).toMatchObject({
      editable: false,
      reason: 'This room has no permission settings to edit.',
    });
    await expect(
      firstValueFrom(service.save(key(), 'room', new Map([['kick', 0]]))),
    ).rejects.toBeInstanceOf(RoomActionPermissionError);
    expect(me.sendStateEvent).not.toHaveBeenCalled();
  });

  it('powerFromDefault is true when users lacks me and false when present', () => {
    const me = fixture('@me:hs', { content: { users: { '@a:hs': 100 } } });
    const service = setup(me);

    expect(service.view(key(), 'room').powerFromDefault).toBe(true);
    me.f.content = { users: { '@me:hs': 50 } };
    expect(service.view(key(), 'room').powerFromDefault).toBe(false);
  });

  it('save writes only changed rows onto the live event', async () => {
    const me = fixture('@me:hs');
    const service = setup(me);
    service.view(key(), 'room');
    me.f.content = {
      kick: 50,
      ban: 80,
      users: { '@me:hs': 50, '@b:hs': 100 },
    };

    await firstValueFrom(
      service.save(key(), 'room', new Map([['send-messages', 50]])),
    );

    expect(me.sendStateEvent).toHaveBeenCalledWith(
      ROOM,
      'm.room.power_levels',
      expect.objectContaining({
        ban: 80,
        events_default: 50,
        users: { '@me:hs': 50, '@b:hs': 100 },
      }),
      '',
    );
  });

  it('save refuses a row that became higher than me', async () => {
    const me = fixture('@me:hs');
    const service = setup(me);
    me.f.content = { kick: 100, users: { '@me:hs': 50 } };

    await expect(
      firstValueFrom(service.save(key(), 'room', new Map([['kick', 0]]))),
    ).rejects.toMatchObject({ message: HIGHER });
    expect(me.sendStateEvent).not.toHaveBeenCalled();
  });

  it.each([60, 1.5, Number.MAX_SAFE_INTEGER + 2])(
    'save refuses level %s',
    async (level) => {
      const me = fixture('@me:hs');

      await expect(
        firstValueFrom(
          setup(me).save(key(), 'room', new Map([['kick', level]])),
        ),
      ).rejects.toBeInstanceOf(RoomActionPermissionError);
      expect(me.sendStateEvent).not.toHaveBeenCalled();
    },
  );

  it("uses the given account's client", async () => {
    const active = fixture('@active:hs');
    const other = fixture('@other:hs', {
      content: { users: { '@other:hs': 50 } },
    });
    const service = setup(active, other);

    await firstValueFrom(
      service.save(key('@other:hs'), 'room', new Map([['kick', 10]])),
    );

    expect(other.sendStateEvent).toHaveBeenCalledOnce();
    expect(active.sendStateEvent).not.toHaveBeenCalled();
  });
});
