import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { firstValueFrom } from 'rxjs';
import { MatrixError, Method } from 'matrix-js-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_PACK_EVENT_TYPE,
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
} from './image-pack.service';
import {
  ImagePackManagementError,
  ImagePackManagementService,
  inspectStatePacks,
  readManagedImagePacks,
  validateImagePackSource,
} from './image-pack-management.service';

function event(type: string, stateKey: string, content: unknown) {
  return {
    getType: () => type,
    getStateKey: () => stateKey,
    getContent: () => content,
  };
}

function pack(name: string, usage: unknown = ['sticker']) {
  return {
    pack: { display_name: name, usage, attribution: `${name} authors` },
    images: { wave: { url: `mxc://hs/${name.toLowerCase()}` } },
  };
}

function room(roomId: string, events: ReturnType<typeof event>[]) {
  const state = {
    getStateEvents: (type: string, stateKey?: string) => {
      const matches = events.filter(
        (candidate) => candidate.getType() === type,
      );
      return stateKey === undefined
        ? matches
        : (matches.find((candidate) => candidate.getStateKey() === stateKey) ??
            null);
    },
  };
  return {
    roomId,
    name: `Room ${roomId}`,
    getMyMembership: () => 'join',
    getLiveTimeline: () => ({ getState: () => state }),
  };
}

function setup(options?: {
  stable?: unknown | null;
  legacy?: unknown | null;
  roomEvents?: ReturnType<typeof event>[];
}) {
  const activeUserId = signal<string | null>('@alice:hs');
  let stable: unknown | null = options?.stable ?? null;
  const legacy: unknown | null = options?.legacy ?? null;
  const packRoom = room('!pack:hs', options?.roomEvents ?? []);
  const client = {
    getUserId: vi.fn(() => '@alice:hs'),
    getAccountData: vi.fn((type: string) => {
      const content = type === IMAGE_PACK_ROOMS_EVENT_TYPE ? stable : legacy;
      return content === null ? undefined : event(type, '', content);
    }),
    http: {
      authedRequest: vi.fn(async (_method: Method, path: string) => {
        const content = path.endsWith(
          encodeURIComponent(IMAGE_PACK_ROOMS_EVENT_TYPE),
        )
          ? stable
          : legacy;
        if (content === null) {
          throw new MatrixError({ errcode: 'M_NOT_FOUND' }, 404);
        }
        return structuredClone(content);
      }),
    },
    setAccountData: vi.fn(async (_type: string, content: unknown) => {
      stable = structuredClone(content);
    }),
    getRoom: vi.fn((roomId: string) =>
      roomId === '!pack:hs' ? packRoom : null,
    ),
    getRoomIdForAlias: vi.fn(async () => ({
      room_id: '!pack:hs',
      servers: ['hs'],
    })),
    joinRoom: vi.fn(async () => packRoom),
    roomState: vi.fn(async () =>
      (options?.roomEvents ?? []).map((candidate) => ({
        type: candidate.getType(),
        state_key: candidate.getStateKey(),
        content: candidate.getContent(),
        room_id: '!pack:hs',
      })),
    ),
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
      ImagePackManagementService,
      { provide: MatrixClientService, useValue: matrix },
    ],
  });
  return {
    client,
    service: TestBed.inject(ImagePackManagementService),
    stable: () => stable,
  };
}

describe('image-pack management parsing', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('accepts room ids and aliases but rejects unsafe source text', () => {
    expect(validateImagePackSource(' #packs:example.org ')).toBe(
      '#packs:example.org',
    );
    expect(validateImagePackSource('!packs:example.org')).toBe(
      '!packs:example.org',
    );
    expect(validateImagePackSource('#packs:example.org:8448')).toBe(
      '#packs:example.org:8448',
    );
    expect(validateImagePackSource('#packs:[2001:db8::1]:8448')).toBe(
      '#packs:[2001:db8::1]:8448',
    );
    expect(() => validateImagePackSource('https://example.org')).toThrow(
      ImagePackManagementError,
    );
  });

  it('lets stable state mask same-key legacy state even when malformed', () => {
    const packs = inspectStatePacks('!pack:hs', 'Pack room', [
      {
        type: LEGACY_IMAGE_PACK_EVENT_TYPE,
        state_key: 'same',
        content: pack('Legacy'),
      },
      {
        type: IMAGE_PACK_EVENT_TYPE,
        state_key: 'same',
        content: {},
      },
    ]);

    expect(packs).toMatchObject([
      { stateKey: 'same', eventType: 'stable', status: 'malformed' },
    ]);
  });

  it('reports empty packs and bounds image counts', () => {
    const images = Object.fromEntries(
      Array.from({ length: 510 }, (_, index) => [
        `image-${index}`,
        { url: `mxc://hs/${index}` },
      ]),
    );
    const packs = inspectStatePacks('!pack:hs', null, [
      {
        type: IMAGE_PACK_EVENT_TYPE,
        state_key: '',
        content: { images: {} },
      },
      {
        type: IMAGE_PACK_EVENT_TYPE,
        state_key: 'large',
        content: { images },
      },
    ]);

    expect(packs[0]).toMatchObject({ stateKey: '', status: 'empty' });
    expect(packs[1]).toMatchObject({ imageCount: 500, status: 'available' });
  });

  it('keeps inaccessible references removable and ignores room-level empty maps', () => {
    const client = {
      getAccountData: () =>
        event(IMAGE_PACK_ROOMS_EVENT_TYPE, '', {
          rooms: {
            '!empty:hs': {},
            '!missing:hs': { pack: {} },
          },
        }),
      getRoom: () => null,
    };

    expect(readManagedImagePacks(client as never)).toMatchObject([
      {
        roomId: '!missing:hs',
        stateKey: 'pack',
        status: 'unavailable',
      },
    ]);
  });

  it('uses stable account data exclusively when legacy references also exist', () => {
    const client = {
      getAccountData: (type: string) =>
        type === IMAGE_PACK_ROOMS_EVENT_TYPE
          ? event(type, '', { rooms: {} })
          : event(type, '', { rooms: { '!legacy:hs': { old: true } } }),
      getRoom: () => null,
    };

    expect(readManagedImagePacks(client as never)).toEqual([]);
  });
});

describe('ImagePackManagementService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('resolves an alias, discovers authoritative state, and deduplicates legacy', async () => {
    const { service, client } = setup({
      roomEvents: [
        event(LEGACY_IMAGE_PACK_EVENT_TYPE, 'fun', pack('Old')),
        event(IMAGE_PACK_EVENT_TYPE, 'fun', pack('Fun')),
        event(IMAGE_PACK_EVENT_TYPE, 'second', pack('Second')),
      ],
    });

    const result = await firstValueFrom(service.discover('#packs:hs'));

    expect(client.getRoomIdForAlias).toHaveBeenCalledWith('#packs:hs');
    expect(client.roomState).toHaveBeenCalledWith('!pack:hs');
    expect(result.packs.map((candidate) => candidate.name)).toEqual([
      'Fun',
      'Second',
    ]);
    expect(result.packs[0].eventType).toBe('stable');
  });

  it('migrates legacy references on first stable install and writes empty objects', async () => {
    const { service, stable } = setup({
      legacy: {
        rooms: { '!old:hs': { old: true } },
      },
    });

    await firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'new' }),
    );

    expect(stable()).toEqual({
      rooms: {
        '!old:hs': { old: {} },
        '!pack:hs': { new: {} },
      },
    });
  });

  it('preserves unknown stable fields and removes empty room maps', async () => {
    const { service, stable } = setup({
      stable: {
        future: { value: 1 },
        rooms: {
          '!pack:hs': { remove: {} },
          '!other:hs': { keep: { future: true } },
        },
      },
    });

    await firstValueFrom(
      service.uninstall({ roomId: '!pack:hs', stateKey: 'remove' }),
    );

    expect(stable()).toEqual({
      future: { value: 1 },
      rooms: { '!other:hs': { keep: { future: true } } },
    });
  });

  it('preserves future fields on an already-installed reference', async () => {
    const { service, stable } = setup({
      stable: {
        rooms: { '!pack:hs': { keep: { future: 'value' } } },
      },
    });

    await firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'keep' }),
    );

    expect(stable()).toEqual({
      rooms: { '!pack:hs': { keep: { future: 'value' } } },
    });
  });

  it('reads account data directly from the server before merging', async () => {
    const { service, client, stable } = setup({
      stable: { rooms: { '!other:hs': { remote: {} } } },
    });
    client.getAccountData.mockReturnValue(undefined);

    await firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'local' }),
    );

    expect(client.http.authedRequest).toHaveBeenCalledWith(
      Method.Get,
      '/user/%40alice%3Ahs/account_data/m.image_pack.rooms',
    );
    expect(stable()).toEqual({
      rooms: {
        '!other:hs': { remote: {} },
        '!pack:hs': { local: {} },
      },
    });
  });

  it('serializes same-client writes and merges each against fresh state', async () => {
    const { service, client, stable } = setup({ stable: { rooms: {} } });
    let releaseFirst: (() => void) | undefined;
    client.setAccountData.mockImplementationOnce(
      async (_type: string, content: unknown) => {
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        await Promise.resolve();
        const target = stable() as Record<string, unknown>;
        Object.assign(target, structuredClone(content));
      },
    );

    const first = firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'one' }),
    );
    const second = firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'two' }),
    );
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    expect(client.setAccountData).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(client.setAccountData).toHaveBeenCalledTimes(2);
    expect(stable()).toEqual({
      rooms: { '!pack:hs': { one: {}, two: {} } },
    });
  });

  it('reports a conflict after bounded failed verification', async () => {
    const { service, client } = setup({ stable: { rooms: {} } });
    client.setAccountData.mockResolvedValue(undefined);

    await expect(
      firstValueFrom(service.install({ roomId: '!pack:hs', stateKey: 'lost' })),
    ).rejects.toMatchObject({ code: 'write-conflict' });
    expect(client.setAccountData).toHaveBeenCalledTimes(3);
  });
});
