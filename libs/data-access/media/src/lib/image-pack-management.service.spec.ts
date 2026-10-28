import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SESSION_SNAPSHOT } from '@trinity/data-access/matrix-client';
import { EngineRequestError, engineFail, engineOk } from '@trinity/util/matrix';
import { firstValueFrom, from, of, switchMap } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExpressionEngine } from '../contract/fake-expression-engine';
import type { PackRoomSnapshot } from './expression-engine';
import { EXPRESSION_ENGINE } from './expression-engine.token';
import {
  IMAGE_PACK_EVENT_TYPE,
  IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
  LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE,
  TRINITY_IMAGE_PACK_ENABLED_USAGE,
} from './image-pack.service';
import {
  mutateSelectionEnabledUsage,
  type RawImagePackStateEvent,
} from './image-pack-management.model';
import {
  ImagePackManagementError,
  ImagePackManagementService,
  inspectStatePacks,
  readManagedImagePacks,
  validateImagePackSource,
} from './image-pack-management.service';
import { sessionWith } from './media.spec-harness';

function event(
  type: string,
  stateKey: string,
  content: unknown,
): RawImagePackStateEvent {
  return { type, state_key: stateKey, content };
}

function pack(name: string, usage: unknown = ['sticker']) {
  return {
    pack: { display_name: name, usage, attribution: `${name} authors` },
    images: { wave: { url: `mxc://hs/${name.toLowerCase()}` } },
  };
}

function room(
  roomId: string,
  packEvents: readonly RawImagePackStateEvent[],
  joined = true,
): PackRoomSnapshot {
  return {
    roomId,
    joined,
    name: `Room ${roomId}`,
    canWritePack: false,
    packEvents,
  };
}

const ALIAS = '#packs:fake';
const FAILED = {
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 500 },
} as const;

function setup(options?: {
  stable?: Record<string, unknown> | null;
  legacy?: Record<string, unknown> | null;
  roomEvents?: RawImagePackStateEvent[];
}) {
  const engine = new FakeExpressionEngine();
  const alice = engine.alice;
  // Bound before the spies, so another device's writes are not counted as this one's.
  const remote = engine.setAccountData.bind(engine);
  if (options?.stable) {
    remote(alice, IMAGE_PACK_ROOMS_EVENT_TYPE, options.stable).subscribe();
  }
  if (options?.legacy) {
    remote(
      alice,
      LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE,
      options.legacy,
    ).subscribe();
  }
  const packRoom = engine.addRoom({
    name: 'Pack room',
    alias: ALIAS,
    joined: false,
    state: options?.roomEvents ?? [],
  });
  const write = vi.spyOn(engine, 'setAccountData');
  const fetch = vi.spyOn(engine, 'fetchAccountData');
  const session = signal(sessionWith(alice, [alice, '@bob:fake']));
  TestBed.configureTestingModule({
    providers: [
      { provide: EXPRESSION_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  /** The server's copy of the stable selection. */
  const stable = (): unknown => {
    let content: unknown = null;
    engine
      .accountData(alice, [IMAGE_PACK_ROOMS_EVENT_TYPE])
      .subscribe(
        (snapshot) => (content = snapshot[IMAGE_PACK_ROOMS_EVENT_TYPE]),
      )
      .unsubscribe();
    return content;
  };
  return {
    service: TestBed.inject(ImagePackManagementService),
    engine,
    alice,
    session,
    packRoom,
    remote,
    write,
    fetch,
    stable,
  };
}

/** Lets effects run and a scheduled reconcile publish. */
async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
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

  it('excludes unsafe state keys from discovery without truncating identity', () => {
    const packs = inspectStatePacks('!pack:hs', null, [
      {
        type: IMAGE_PACK_EVENT_TYPE,
        state_key: 'safe',
        content: pack('Safe'),
      },
      {
        type: IMAGE_PACK_EVENT_TYPE,
        state_key: 'x'.repeat(256),
        content: pack('Oversized'),
      },
      {
        type: IMAGE_PACK_EVENT_TYPE,
        state_key: 'control\u0000key',
        content: pack('Control'),
      },
    ]);

    expect(packs.map((candidate) => candidate.stateKey)).toEqual(['safe']);
  });

  it('keeps inaccessible references removable and ignores room-level empty maps', () => {
    const data = {
      [IMAGE_PACK_ROOMS_EVENT_TYPE]: {
        rooms: {
          '!empty:hs': {},
          '!missing:hs': { pack: {} },
        },
      },
    };

    expect(readManagedImagePacks(data, [])).toMatchObject([
      {
        roomId: '!missing:hs',
        stateKey: 'pack',
        status: 'unavailable',
      },
    ]);
  });

  it('reads a namespaced enabled-usage preference from installed references', () => {
    const data = {
      [IMAGE_PACK_ROOMS_EVENT_TYPE]: {
        rooms: {
          '!pack:hs': {
            fun: { [TRINITY_IMAGE_PACK_ENABLED_USAGE]: ['emoticon'] },
          },
        },
      },
    };
    const rooms = [
      room('!pack:hs', [
        event(
          IMAGE_PACK_EVENT_TYPE,
          'fun',
          pack('Fun', ['emoticon', 'sticker']),
        ),
      ]),
    ];

    expect(readManagedImagePacks(data, rooms)).toMatchObject([
      { usage: ['emoticon', 'sticker'], enabledUsage: ['emoticon'] },
    ]);
  });

  it('uses stable account data exclusively when legacy references also exist', () => {
    const data = {
      [IMAGE_PACK_ROOMS_EVENT_TYPE]: { rooms: {} },
      [LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE]: {
        rooms: { '!legacy:hs': { old: true } },
      },
    };

    expect(readManagedImagePacks(data, [])).toEqual([]);
  });

  it('names an unavailable pack after its room and reports a missing one', () => {
    const data = {
      [IMAGE_PACK_ROOMS_EVENT_TYPE]: {
        rooms: { '!left:hs': { fun: {} }, '!pack:hs': { gone: {} } },
      },
    };
    const rooms = [
      room(
        '!left:hs',
        [event(IMAGE_PACK_EVENT_TYPE, 'fun', pack('Fun'))],
        false,
      ),
      room('!pack:hs', []),
    ];

    expect(readManagedImagePacks(data, rooms)).toMatchObject([
      { roomId: '!left:hs', name: 'Room !left:hs', status: 'unavailable' },
      { roomId: '!pack:hs', name: 'Room !pack:hs', status: 'missing' },
    ]);
  });
});

describe('ImagePackManagementService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('resolves an alias, discovers authoritative state, and deduplicates legacy', async () => {
    const { service, engine, alice, packRoom } = setup({
      roomEvents: [
        event(LEGACY_IMAGE_PACK_EVENT_TYPE, 'fun', pack('Old')),
        event(IMAGE_PACK_EVENT_TYPE, 'fun', pack('Fun')),
        event(IMAGE_PACK_EVENT_TYPE, 'second', pack('Second')),
      ],
    });
    const join = vi.spyOn(engine, 'joinPackRoom');

    const result = await firstValueFrom(service.discover(` ${ALIAS} `));

    expect(join).toHaveBeenCalledWith(alice, ALIAS);
    expect(result.roomId).toBe(packRoom);
    expect(result.roomName).toBe('Pack room');
    expect(result.packs.map((candidate) => candidate.name)).toEqual([
      'Fun',
      'Second',
    ]);
    expect(result.packs[0].eventType).toBe('stable');
  });

  it('reports a room without usable packs, and a failed join as a request failure', async () => {
    const { service } = setup();

    await expect(firstValueFrom(service.discover(ALIAS))).rejects.toMatchObject(
      {
        code: 'no-packs',
      },
    );
    await expect(
      firstValueFrom(service.discover('#unknown:fake')),
    ).rejects.toBeInstanceOf(EngineRequestError);
  });

  it('refuses to manage packs with no active account', async () => {
    const { service, session } = setup();
    session.set(sessionWith(null, []));

    await expect(firstValueFrom(service.discover(ALIAS))).rejects.toMatchObject(
      {
        code: 'not-signed-in',
      },
    );
    await expect(
      firstValueFrom(service.install({ roomId: '!pack:hs', stateKey: 'x' })),
    ).rejects.toMatchObject({ code: 'not-signed-in' });
  });

  it('projects installed packs for the active account and shows an install at once', async () => {
    const { service, alice, session, packRoom } = setup({
      roomEvents: [event(IMAGE_PACK_EVENT_TYPE, 'fun', pack('Fun'))],
    });
    service.connect();
    await settle();
    expect(service.installed()).toEqual([]);

    await firstValueFrom(service.discover(ALIAS));
    await firstValueFrom(
      service.install({ roomId: packRoom, stateKey: 'fun' }),
    );
    expect(service.installed()).toMatchObject([
      { roomId: packRoom, stateKey: 'fun', name: 'Fun', status: 'available' },
    ]);

    session.set(sessionWith('@bob:fake', [alice, '@bob:fake']));
    await settle();
    expect(service.installed()).toEqual([]);

    session.set(sessionWith(alice, [alice, '@bob:fake']));
    await settle();
    expect(service.installed()).toMatchObject([{ name: 'Fun' }]);
    service.disconnect();
    expect(service.installed()).toEqual([]);
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

  it('round-trips a prototype-named state key as account data', async () => {
    const { service, stable } = setup({ stable: { rooms: {} } });
    const source = { roomId: '!pack:hs', stateKey: '__proto__' };

    await firstValueFrom(service.install(source));
    expect(
      Object.hasOwn(
        (stable() as { rooms: Record<string, Record<string, unknown>> }).rooms[
          source.roomId
        ],
        source.stateKey,
      ),
    ).toBe(true);

    await firstValueFrom(
      service.setEnabledUsage({ ...source, usage: ['emoticon', 'sticker'] }, [
        'sticker',
      ]),
    );
    expect(stable()).toEqual({
      rooms: {
        '!pack:hs': {
          ['__proto__']: {
            [TRINITY_IMAGE_PACK_ENABLED_USAGE]: ['sticker'],
          },
        },
      },
    });

    await firstValueFrom(service.uninstall(source));
    expect(stable()).toEqual({ rooms: {} });
  });

  it('stores enabled usages in a namespaced field and preserves extensions', async () => {
    const { service, stable } = setup({
      stable: {
        future: { value: 1 },
        rooms: {
          '!pack:hs': { fun: { future: true } },
          '!other:hs': { keep: {} },
        },
      },
    });

    await firstValueFrom(
      service.setEnabledUsage(
        {
          roomId: '!pack:hs',
          stateKey: 'fun',
          usage: ['emoticon', 'sticker'],
        },
        ['emoticon'],
      ),
    );

    expect(stable()).toEqual({
      future: { value: 1 },
      rooms: {
        '!pack:hs': {
          fun: {
            future: true,
            [TRINITY_IMAGE_PACK_ENABLED_USAGE]: ['emoticon'],
          },
        },
        '!other:hs': { keep: {} },
      },
    });
  });

  it('removes the extension when every supported usage is enabled', async () => {
    const { service, stable } = setup({
      stable: {
        rooms: {
          '!pack:hs': {
            fun: { [TRINITY_IMAGE_PACK_ENABLED_USAGE]: ['emoticon'] },
          },
        },
      },
    });

    await firstValueFrom(
      service.setEnabledUsage(
        {
          roomId: '!pack:hs',
          stateKey: 'fun',
          usage: ['emoticon', 'sticker'],
        },
        ['sticker', 'emoticon'],
      ),
    );

    expect(stable()).toEqual({ rooms: { '!pack:hs': { fun: {} } } });
  });

  it('migrates legacy references when changing an enabled usage', async () => {
    const { service, stable } = setup({
      legacy: {
        rooms: {
          '!old:hs': { old: true },
          '!pack:hs': { fun: true },
        },
      },
    });

    await firstValueFrom(
      service.setEnabledUsage(
        {
          roomId: '!pack:hs',
          stateKey: 'fun',
          usage: ['emoticon', 'sticker'],
        },
        ['sticker'],
      ),
    );

    expect(stable()).toEqual({
      rooms: {
        '!old:hs': { old: {} },
        '!pack:hs': {
          fun: { [TRINITY_IMAGE_PACK_ENABLED_USAGE]: ['sticker'] },
        },
      },
    });
  });

  it('reads account data directly from the server before merging', async () => {
    const { service, alice, fetch, stable } = setup({
      stable: { rooms: { '!other:hs': { remote: {} } } },
    });

    await firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'local' }),
    );

    expect(fetch).toHaveBeenCalledWith(alice, IMAGE_PACK_ROOMS_EVENT_TYPE);
    expect(stable()).toEqual({
      rooms: {
        '!other:hs': { remote: {} },
        '!pack:hs': { local: {} },
      },
    });
  });

  it('retries when verification contains an unrelated remote change', async () => {
    const { service, write, fetch, stable } = setup({ stable: { rooms: {} } });
    const changed = {
      remote: { revision: 1 },
      rooms: { '!pack:hs': { local: {} } },
    };
    fetch
      .mockReturnValueOnce(of(engineOk({ rooms: {} })))
      .mockReturnValueOnce(of(engineOk(changed)))
      .mockReturnValueOnce(of(engineOk(changed)));

    await firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'local' }),
    );

    expect(write).toHaveBeenCalledTimes(2);
    expect(stable()).toEqual({
      remote: { revision: 1 },
      rooms: { '!pack:hs': { local: {} } },
    });
  });

  it('serializes same-account writes and merges each against fresh state', async () => {
    const { service, remote, write, stable } = setup({ stable: { rooms: {} } });
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    write.mockImplementationOnce((accountId, type, content) =>
      from(gate).pipe(switchMap(() => remote(accountId, type, content))),
    );

    const first = firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'one' }),
    );
    const second = firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'two' }),
    );
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    await settle();
    expect(write).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(write).toHaveBeenCalledTimes(2);
    expect(stable()).toEqual({
      rooms: { '!pack:hs': { one: {}, two: {} } },
    });
  });

  it('reports a conflict after bounded failed verification', async () => {
    const { service, write } = setup({ stable: { rooms: {} } });
    write.mockReturnValue(of(engineOk(null)));

    await expect(
      firstValueFrom(service.install({ roomId: '!pack:hs', stateKey: 'lost' })),
    ).rejects.toMatchObject({ code: 'write-conflict' });
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('rejects a failed write and keeps the next one queued behind it', async () => {
    const { service, write, stable } = setup({ stable: { rooms: {} } });
    write.mockReturnValueOnce(of(engineFail(FAILED)));

    await expect(
      firstValueFrom(service.install({ roomId: '!pack:hs', stateKey: 'one' })),
    ).rejects.toBeInstanceOf(EngineRequestError);
    await firstValueFrom(
      service.install({ roomId: '!pack:hs', stateKey: 'two' }),
    );

    expect(stable()).toEqual({ rooms: { '!pack:hs': { two: {} } } });
  });
});

describe('mutateSelectionEnabledUsage', () => {
  it('drops the retired enabled-usage key when it rewrites a reference', () => {
    const content = {
      rooms: {
        '!pack:hs': {
          fun: { [LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE]: ['sticker'] },
        },
      },
    };
    const source = {
      roomId: '!pack:hs',
      stateKey: 'fun',
      usage: ['emoticon', 'sticker'],
    } as never;
    const next = mutateSelectionEnabledUsage(content, source, ['emoticon']);
    const reference = (
      next['rooms'] as Record<string, Record<string, Record<string, unknown>>>
    )['!pack:hs']['fun'];
    expect(reference[TRINITY_IMAGE_PACK_ENABLED_USAGE]).toEqual(['emoticon']);
    expect(LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE in reference).toBe(false);
  });
});
