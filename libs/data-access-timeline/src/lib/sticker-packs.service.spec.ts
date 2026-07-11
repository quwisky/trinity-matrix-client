import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { StickerPacksService } from './sticker-packs.service';

function accountData(content: unknown) {
  return { getContent: () => content };
}

function stateEvent(content: unknown, stateKey = '') {
  return { getContent: () => content, getStateKey: () => stateKey };
}

function room(o: {
  roomId: string;
  name: string;
  membership?: string;
  emotes?: ReturnType<typeof stateEvent>[];
}) {
  return {
    roomId: o.roomId,
    name: o.name,
    getMyMembership: () => o.membership ?? 'join',
    currentState: {
      getStateEvents: (type: string) =>
        type === 'im.ponies.room_emotes' ? (o.emotes ?? []) : [],
    },
  };
}

function setup(over: {
  initialized?: boolean;
  userEmotes?: unknown;
  rooms?: ReturnType<typeof room>[];
}) {
  const instance = {
    getAccountData: (type: string) =>
      type === 'im.ponies.user_emotes' && over.userEmotes !== undefined
        ? accountData(over.userEmotes)
        : undefined,
    getRooms: () => over.rooms ?? [],
  };
  TestBed.configureTestingModule({
    providers: [
      StickerPacksService,
      MockProvider(MatrixClientService, {
        isInitialized: over.initialized ?? true,
        instance: instance as never,
      }),
    ],
  });
  return TestBed.inject(StickerPacksService);
}

describe('StickerPacksService', () => {
  it('returns an empty list when not signed in', () => {
    const svc = setup({ initialized: false });
    expect(svc.packs()).toEqual([]);
    expect(svc.hasStickers()).toBe(false);
  });

  it('reads the personal pack from account data first', () => {
    const svc = setup({
      userEmotes: {
        pack: { display_name: 'Mine' },
        images: { a: { url: 'mxc://hs/a' } },
      },
    });

    const packs = svc.packs();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ id: 'user', displayName: 'Mine' });
    expect(svc.hasStickers()).toBe(true);
  });

  it('reads room packs from joined rooms, keyed by room + state key', () => {
    const svc = setup({
      rooms: [
        room({
          roomId: '!r:hs',
          name: 'Design',
          emotes: [
            stateEvent({ images: { blob: { url: 'mxc://hs/blob' } } }, 'set1'),
          ],
        }),
      ],
    });

    const packs = svc.packs();
    expect(packs).toHaveLength(1);
    expect(packs[0]).toMatchObject({ id: '!r:hs|set1', displayName: 'Design' });
  });

  it('skips rooms the user has not joined', () => {
    const svc = setup({
      rooms: [
        room({
          roomId: '!inv:hs',
          name: 'Invited',
          membership: 'invite',
          emotes: [stateEvent({ images: { x: { url: 'mxc://hs/x' } } })],
        }),
      ],
    });

    expect(svc.packs()).toEqual([]);
  });

  it('orders the personal pack before room packs and drops empty packs', () => {
    const svc = setup({
      userEmotes: { images: { me: { url: 'mxc://hs/me' } } },
      rooms: [
        room({
          roomId: '!r:hs',
          name: 'Room',
          emotes: [
            stateEvent({ images: {} }), // empty → dropped
            stateEvent({ images: { r: { url: 'mxc://hs/r' } } }, 'k'),
          ],
        }),
      ],
    });

    expect(svc.packs().map((p) => p.id)).toEqual(['user', '!r:hs|k']);
  });
});
