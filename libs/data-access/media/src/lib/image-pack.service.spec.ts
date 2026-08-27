import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_PACK_EVENT_TYPE,
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  ImagePackService,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
  readImagePacks,
} from './image-pack.service';

function event(
  type: string,
  stateKey: string,
  content: unknown,
  roomId = '!pack:hs',
) {
  return {
    getType: () => type,
    getStateKey: () => stateKey,
    getContent: () => content,
    getRoomId: () => roomId,
  };
}

function setup() {
  const activeUserId = signal<string | null>('@alice:hs');
  const account = new Map<string, ReturnType<typeof event>>();
  const roomEvents = new Map<string, ReturnType<typeof event>[]>();
  const rooms = new Map<string, unknown>();
  const rebuildRoom = (roomId: string) => {
    const state = {
      getStateEvents: (type: string, stateKey?: string) => {
        const matches = (roomEvents.get(roomId) ?? []).filter(
          (candidate) => candidate.getType() === type,
        );
        return stateKey === undefined
          ? matches
          : (matches.find(
              (candidate) => candidate.getStateKey() === stateKey,
            ) ?? null);
      },
    };
    rooms.set(roomId, {
      roomId,
      name: `Room ${roomId}`,
      getLiveTimeline: () => ({ getState: () => state }),
    });
  };
  const client = {
    getAccountData: (type: string) => account.get(type),
    getRoom: (roomId: string) => rooms.get(roomId) ?? null,
    on: vi.fn(),
    off: vi.fn(),
  };
  const matrix = {
    isInitialized: true,
    instance: client,
    activeUserId: activeUserId.asReadonly(),
  };
  TestBed.configureTestingModule({
    providers: [
      ImagePackService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  return {
    service: TestBed.inject(ImagePackService),
    client,
    account,
    roomEvents,
    rebuildRoom,
  };
}

function pack(name: string, usage?: unknown, extraImages = 0) {
  const images: Record<string, unknown> = {
    wave: {
      url: `mxc://hs/${name}`,
      body: `${name} wave`,
      info: {
        mimetype: 'image/png',
        size: 2048,
        w: 32,
        h: 24,
        thumbnail_url: 'mxc://hs/thumb',
        thumbnail_info: { mimetype: 'image/png', w: 16, h: 12 },
      },
    },
  };
  for (let index = 0; index < extraImages; index += 1) {
    images[`x${index.toString().padStart(3, '0')}`] = {
      url: `mxc://hs/${index}`,
    };
  }
  return {
    pack: { display_name: name, ...(usage === undefined ? {} : { usage }) },
    images,
  };
}

describe('ImagePackService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('orders account-selected packs before current-room packs and reads both usages', () => {
    const { client, account, roomEvents, rebuildRoom } = setup();
    account.set(
      IMAGE_PACK_ROOMS_EVENT_TYPE,
      event(IMAGE_PACK_ROOMS_EVENT_TYPE, '', {
        rooms: { '!pack:hs': { global: {} } },
      }),
    );
    roomEvents.set('!pack:hs', [
      event(IMAGE_PACK_EVENT_TYPE, 'global', pack('Global')),
    ]);
    roomEvents.set('!current:hs', [
      event(IMAGE_PACK_EVENT_TYPE, 'local', pack('Local', ['sticker'])),
    ]);
    rebuildRoom('!pack:hs');
    rebuildRoom('!current:hs');

    const packs = readImagePacks(client as never, '!current:hs');

    expect(packs.map((item) => item.name)).toEqual(['Global', 'Local']);
    expect(packs[0].images[0].usage).toEqual(['emoticon', 'sticker']);
    expect(packs[1].images[0].usage).toEqual(['sticker']);
    expect(packs[0].images[0].info).toEqual({
      mimetype: 'image/png',
      size: 2048,
      w: 32,
      h: 24,
      thumbnail_url: 'mxc://hs/thumb',
      thumbnail_info: { mimetype: 'image/png', w: 16, h: 12 },
    });
  });

  it('lets stable pack state override a legacy selection for the same source', () => {
    const { client, account, roomEvents, rebuildRoom } = setup();
    account.set(
      LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
      event(LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE, '', {
        rooms: { '!pack:hs': { same: {}, old: {} } },
      }),
    );
    roomEvents.set('!pack:hs', [
      event(LEGACY_IMAGE_PACK_EVENT_TYPE, 'same', pack('Legacy')),
      event(IMAGE_PACK_EVENT_TYPE, 'same', pack('Stable')),
      event(LEGACY_IMAGE_PACK_EVENT_TYPE, 'old', pack('Old')),
    ]);
    rebuildRoom('!pack:hs');

    expect(
      readImagePacks(client as never, '!current:hs').map((item) => item.name),
    ).toEqual(['Old', 'Stable']);
  });

  it('uses legacy account selections only when stable account data is absent', () => {
    const { client, account, roomEvents, rebuildRoom } = setup();
    account.set(
      LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
      event(LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE, '', {
        rooms: { '!pack:hs': { stale: {} } },
      }),
    );
    account.set(
      IMAGE_PACK_ROOMS_EVENT_TYPE,
      event(IMAGE_PACK_ROOMS_EVENT_TYPE, '', {
        rooms: { '!pack:hs': { selected: {} } },
      }),
    );
    roomEvents.set('!pack:hs', [
      event(IMAGE_PACK_EVENT_TYPE, 'stale', pack('Stale')),
      event(IMAGE_PACK_EVENT_TYPE, 'selected', pack('Selected')),
    ]);
    rebuildRoom('!pack:hs');

    expect(
      readImagePacks(client as never, '!current:hs').map((item) => item.name),
    ).toEqual(['Selected']);
  });

  it('uses the source room name when a pack has no display name', () => {
    const { client, roomEvents, rebuildRoom } = setup();
    roomEvents.set('!current:hs', [
      event(
        IMAGE_PACK_EVENT_TYPE,
        'opaque-state-key',
        { images: pack('Unnamed').images },
        '!current:hs',
      ),
    ]);
    rebuildRoom('!current:hs');

    expect(readImagePacks(client as never, '!current:hs')[0].name).toBe(
      'Room !current:hs',
    );
  });

  it('drops malformed URLs/usages and bounds oversized packs', () => {
    const { client, roomEvents, rebuildRoom } = setup();
    const oversized = pack('Big', [], 600);
    (oversized.images as Record<string, unknown>)['remote'] = {
      url: 'https://tracker.example/pixel.png',
    };
    roomEvents.set('!current:hs', [
      event(IMAGE_PACK_EVENT_TYPE, 'big', oversized, '!current:hs'),
      event(
        IMAGE_PACK_EVENT_TYPE,
        'invalid',
        pack('Invalid', ['not-a-usage']),
        '!current:hs',
      ),
    ]);
    rebuildRoom('!current:hs');

    const packs = readImagePacks(client as never, '!current:hs');
    expect(packs).toHaveLength(1);
    expect(packs[0].images).toHaveLength(500);
    expect(packs[0].images.some((item) => item.url.startsWith('https:'))).toBe(
      false,
    );
  });

  it('rebuilds for relevant live events and detaches cleanly', async () => {
    const { service, client, roomEvents, rebuildRoom } = setup();
    roomEvents.set('!current:hs', []);
    rebuildRoom('!current:hs');
    const packs = service.packsFor('!current:hs');
    service.connect('!current:hs');
    roomEvents
      .get('!current:hs')
      ?.push(
        event(IMAGE_PACK_EVENT_TYPE, 'local', pack('Live'), '!current:hs'),
      );
    const handler = client.on.mock.calls.find(
      ([name]) => name === 'RoomState.events',
    )?.[1] as ((changed: ReturnType<typeof event>) => void) | undefined;
    handler?.(event(IMAGE_PACK_EVENT_TYPE, 'local', {}, '!current:hs'));
    await Promise.resolve();

    expect(packs().map((item) => item.name)).toEqual(['Live']);
    service.disconnect('!current:hs');
    expect(packs()).toEqual([]);
    expect(client.off).toHaveBeenCalledWith('RoomState.events', handler);
  });
});
