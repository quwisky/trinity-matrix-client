import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SESSION_SNAPSHOT } from '@trinity/data-access/matrix-client';
import { EngineRequestError, engineFail } from '@trinity/util/matrix';
import {
  firstValueFrom,
  from,
  lastValueFrom,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeExpressionEngine } from '../contract/fake-expression-engine';
import { EXPRESSION_ENGINE } from './expression-engine.token';
import {
  ImagePackEditError,
  ImagePackEditorService,
  sanitizeShortcode,
} from './image-pack-editor.service';
import { prepareImagePackImage } from './image-pack-image';
import {
  LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE,
  PERSONAL_IMAGE_PACK_EVENT_TYPE,
} from './image-pack.model';
import { MediaService } from './media.service';
import { sessionWith } from './media.spec-harness';

vi.mock('./image-pack-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./image-pack-image')>()),
  prepareImagePackImage: vi.fn(async (file: File) => file),
}));

type Content = Record<string, unknown>;

const STABLE = PERSONAL_IMAGE_PACK_EVENT_TYPE;
const LEGACY = LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE;
const UPLOAD_INFO = { mimetype: 'image/png', size: 4, w: 64, h: 64 };
const BOB = '@bob:fake';
const FAILED = {
  kind: 'network',
  code: 'request-failed',
  diagnostic: { kind: 'network' },
} as const;

function setup(
  local: Record<string, Content> = {},
  { active = '@alice:fake' as string | null } = {},
) {
  const engine = new FakeExpressionEngine();
  const alice = engine.alice;
  // Bound before the spy: another device's writes are not this service's.
  const remote = engine.setAccountData.bind(engine);
  for (const [type, content] of Object.entries(local)) {
    remote(alice, type, content).subscribe();
  }
  const write = vi.spyOn(engine, 'setAccountData');
  const session = signal(sessionWith(active, [alice, BOB]));
  let uploads = 0;
  const media = {
    uploadMedia: vi.fn((..._args: unknown[]) => {
      uploads += 1;
      return of({ mxc: `mxc://hs/up${uploads}`, info: UPLOAD_INFO });
    }),
    uploadLimit: vi.fn((_accountId?: string) => of<number | null>(null)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: EXPRESSION_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
      { provide: MediaService, useValue: media },
    ],
  });
  const service = TestBed.inject(ImagePackEditorService);
  const written = () => write.mock.calls.at(-1)?.[2];
  /** Another device's write, synced back. */
  const sync = (type: string, content: Content) =>
    remote(alice, type, content).subscribe();
  /** A local copy behind the server's, as a stale sync echo leaves it. */
  const stale = (snapshot: Content) =>
    vi
      .spyOn(engine, 'accountData')
      .mockReturnValue(of({ [STABLE]: null, [LEGACY]: null, ...snapshot }));
  return {
    service,
    engine,
    alice,
    session,
    media,
    remote,
    write,
    written,
    sync,
    stale,
  };
}

/** Lets effects run and a scheduled reconcile publish. */
async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  TestBed.tick();
}

const existing = (url: string) => ({ kind: 'existing', url }) as const;

function png(name = 'wave.png') {
  return new File([new Uint8Array(4)], name, { type: 'image/png' });
}

function images(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `e${index}`,
      { url: `mxc://hs/e${index}` },
    ]),
  );
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ImagePackEditError);
  return error as ImagePackEditError;
}

describe('ImagePackEditorService', () => {
  beforeEach(() => vi.mocked(prepareImagePackImage).mockClear());
  afterEach(() => TestBed.resetTestingModule());

  it('add uploads, then writes the entry with the requested usage', async () => {
    const { service, alice, media, write } = setup();
    const file = png();

    const entry = await firstValueFrom(
      service.add({ kind: 'file', file }, 'wave', ['sticker']),
    );

    expect(prepareImagePackImage).toHaveBeenCalledWith(file, ['sticker']);
    expect(media.uploadMedia.mock.calls[0]).toEqual(
      expect.arrayContaining([file, false]),
    );
    expect(media.uploadMedia.mock.calls[0][4]).toBe(alice);
    expect(media.uploadLimit).toHaveBeenCalledWith(alice);
    expect(write).toHaveBeenCalledWith(alice, STABLE, {
      pack: { display_name: 'Your emoji' },
      images: {
        wave: { url: 'mxc://hs/up1', info: UPLOAD_INFO, usage: ['sticker'] },
      },
    });
    expect(entry).toEqual({
      shortcode: 'wave',
      url: 'mxc://hs/up1',
      info: UPLOAD_INFO,
      usage: ['sticker'],
    });
  });

  it('add with an existing mxc does not upload', async () => {
    const { service, media, written } = setup();

    await firstValueFrom(
      service.add(
        { kind: 'existing', url: 'mxc://hs/old', info: { w: 1 }, body: 'hi' },
        'hi',
        ['emoticon'],
      ),
    );

    expect(media.uploadMedia).not.toHaveBeenCalled();
    expect(written()?.['images']).toEqual({
      hi: {
        url: 'mxc://hs/old',
        body: 'hi',
        info: { w: 1 },
        usage: ['emoticon'],
      },
    });
  });

  it('rejects a taken shortcode with shortcode-taken', async () => {
    const { service, media, write } = setup({
      [STABLE]: { images: { wave: { url: 'mxc://hs/a' } } },
    });

    const error = await codeOf(
      firstValueFrom(
        service.add({ kind: 'file', file: png() }, 'wave', ['emoticon']),
      ),
    );

    expect(error.code).toBe('shortcode-taken');
    expect(media.uploadMedia).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects the 501st image with pack-full', async () => {
    const { service } = setup({ [STABLE]: { images: images(500) } });

    const error = await codeOf(
      firstValueFrom(
        service.add({ kind: 'existing', url: 'mxc://hs/x' }, 'x', ['emoticon']),
      ),
    );

    expect(error.code).toBe('pack-full');
  });

  it('rejects an invalid shortcode and a file over the server limit', async () => {
    const { service, media } = setup();
    media.uploadLimit.mockReturnValue(of(2 * 1_048_576));
    const big = new File([new Uint8Array(3 * 1_048_576)], 'big.png', {
      type: 'image/png',
    });

    const invalid = await codeOf(
      firstValueFrom(
        service.add({ kind: 'file', file: png() }, 'a b', ['emoticon']),
      ),
    );
    const tooLarge = await codeOf(
      firstValueFrom(
        service.add({ kind: 'file', file: big }, 'big', ['emoticon']),
      ),
    );

    expect(invalid.code).toBe('invalid-shortcode');
    expect(tooLarge.code).toBe('too-large-for-server');
    expect(tooLarge.limitMb).toBe(2);
    expect(media.uploadMedia).not.toHaveBeenCalled();
  });

  it('two quick adds both land', async () => {
    const { service, written } = setup();

    await Promise.all([
      firstValueFrom(
        service.add({ kind: 'file', file: png('a.png') }, 'a', ['emoticon']),
      ),
      firstValueFrom(
        service.add({ kind: 'file', file: png('b.png') }, 'b', ['emoticon']),
      ),
    ]);
    await firstValueFrom(
      service.add({ kind: 'existing', url: 'mxc://hs/c' }, 'c', ['emoticon']),
    );

    expect(Object.keys(written()?.['images'] as Content)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('builds on a synced change once the own write has landed', async () => {
    const { service, written, sync } = setup();
    await firstValueFrom(
      service.add({ kind: 'existing', url: 'mxc://hs/a' }, 'a', ['emoticon']),
    );

    sync(STABLE, { images: { other: { url: 'mxc://hs/o' } } });
    await firstValueFrom(
      service.add({ kind: 'existing', url: 'mxc://hs/b' }, 'b', ['emoticon']),
    );

    expect(Object.keys(written()?.['images'] as Content)).toEqual([
      'other',
      'b',
    ]);
  });

  it('a stale echo after the last write does not drop it', async () => {
    const { service, written, stale } = setup();
    await firstValueFrom(
      service.add(existing('mxc://hs/a'), 'a', ['emoticon']),
    );
    await firstValueFrom(
      service.add(existing('mxc://hs/b'), 'b', ['emoticon']),
    );

    stale({ [STABLE]: { images: { a: { url: 'mxc://hs/a' } } } });
    await firstValueFrom(
      service.add(existing('mxc://hs/c'), 'c', ['emoticon']),
    );

    expect(Object.keys(written()?.['images'] as Content)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('a stale legacy echo does not drop the first write of a legacy-only pack', async () => {
    const { service, written, stale } = setup({
      [LEGACY]: { images: { old: { url: 'mxc://hs/old' } } },
    });
    await firstValueFrom(
      service.add(existing('mxc://hs/a'), 'a', ['emoticon']),
    );

    stale({ [LEGACY]: { images: { old: { url: 'mxc://hs/old' } } } });
    await firstValueFrom(
      service.add(existing('mxc://hs/b'), 'b', ['emoticon']),
    );

    expect(Object.keys(written()?.['images'] as Content)).toEqual([
      'old',
      'a',
      'b',
    ]);
  });

  it('rejects an empty usage with invalid-usage', async () => {
    const { service, write } = setup({
      [STABLE]: { images: { a: { url: 'mxc://hs/a' } } },
    });

    const adding = await codeOf(
      firstValueFrom(service.add(existing('mxc://hs/b'), 'b', [])),
    );
    const changing = await codeOf(
      lastValueFrom(service.setUsage('a', []), { defaultValue: undefined }),
    );

    expect([adding.code, changing.code]).toEqual([
      'invalid-usage',
      'invalid-usage',
    ]);
    expect(write).not.toHaveBeenCalled();
  });

  it('a retry after a failed write reuses the uploaded mxc', async () => {
    const { service, media, write, written } = setup();
    const file = png();
    write.mockReturnValueOnce(of(engineFail(FAILED)));

    await expect(
      firstValueFrom(service.add({ kind: 'file', file }, 'wave', ['emoticon'])),
    ).rejects.toBeInstanceOf(EngineRequestError);
    await firstValueFrom(
      service.add({ kind: 'file', file }, 'wave', ['emoticon']),
    );

    expect(media.uploadMedia).toHaveBeenCalledTimes(1);
    expect(written()?.['images']).toEqual({
      wave: { url: 'mxc://hs/up1', info: UPLOAD_INFO, usage: ['emoticon'] },
    });
  });

  it('rename keeps the entry and fails on a taken target', async () => {
    const wave = { url: 'mxc://hs/a', body: 'wave', usage: ['sticker'] };
    const { service, written } = setup({
      [STABLE]: {
        pack: { display_name: 'Mine' },
        images: { wave, smile: { url: 'mxc://hs/b' } },
      },
    });

    await lastValueFrom(service.rename('wave', 'hello'), {
      defaultValue: undefined,
    });
    const error = await codeOf(
      lastValueFrom(service.rename('hello', 'smile'), {
        defaultValue: undefined,
      }),
    );

    expect(written()).toEqual({
      pack: { display_name: 'Mine' },
      images: { hello: wave, smile: { url: 'mxc://hs/b' } },
    });
    expect(Object.keys(written()?.['images'] as Content)).toEqual([
      'hello',
      'smile',
    ]);
    expect(error.code).toBe('shortcode-taken');
  });

  it('setUsage and remove change only their entry and keep unknown ones', async () => {
    const { service, written } = setup({
      [STABLE]: {
        images: {
          a: { url: 'mxc://hs/a' },
          b: { url: 'mxc://hs/b' },
          broken: { url: 'https://not-mxc' },
        },
      },
    });

    await lastValueFrom(service.setUsage('a', ['sticker']), {
      defaultValue: undefined,
    });
    await lastValueFrom(service.remove('b'), { defaultValue: undefined });

    expect(written()?.['images']).toEqual({
      a: { url: 'mxc://hs/a', usage: ['sticker'] },
      broken: { url: 'https://not-mxc' },
    });
  });

  it('the first write copies a legacy-only pack into m.image_pack', async () => {
    const legacy = {
      pack: { display_name: 'Old emotes', avatar_url: 'mxc://hs/av' },
      images: {
        old: { url: 'mxc://hs/old', usage: ['emoticon'] },
        broken: { url: 42 },
      },
    };
    const { service, alice, write } = setup({
      [LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE]: legacy,
    });

    await firstValueFrom(
      service.add({ kind: 'existing', url: 'mxc://hs/new' }, 'new', [
        'emoticon',
      ]),
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(alice, STABLE, {
      pack: legacy.pack,
      images: {
        ...legacy.images,
        new: { url: 'mxc://hs/new', usage: ['emoticon'] },
      },
    });
  });

  it('personal follows the pack and the active account, and is null signed out', async () => {
    const { service, session, alice, sync } = setup({
      [STABLE]: { images: { a: { url: 'mxc://hs/a' } } },
    });
    expect(service.personal()).toBeNull();

    const lifetime = service.run().subscribe();
    await settle();
    expect(service.personal()?.map((entry) => entry.shortcode)).toEqual(['a']);

    sync(STABLE, { images: { b: { url: 'mxc://hs/b' } } });
    await vi.waitFor(() =>
      expect(service.personal()?.map((entry) => entry.shortcode)).toEqual([
        'b',
      ]),
    );

    // The fake has no pack for bob.
    session.set(sessionWith(BOB, [alice, BOB]));
    await settle();
    expect(service.personal()).toEqual([]);

    session.set(sessionWith(null, []));
    await settle();
    expect(service.personal()).toBeNull();
    lifetime.unsubscribe();
  });

  it('an account switch during a write never shows the previous account’s pack', async () => {
    const { service, session, alice, remote, write } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    write.mockImplementationOnce((accountId, type, content) =>
      from(gate).pipe(switchMap(() => remote(accountId, type, content))),
    );
    const lifetime = service.run().subscribe();
    await settle();

    const adding = firstValueFrom(
      service.add(existing('mxc://hs/a'), 'a', ['emoticon']),
    );
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    session.set(sessionWith(BOB, [alice, BOB]));
    await settle();
    release();
    await adding;

    expect(write.mock.calls[0][0]).toBe(alice);
    expect(service.personal()).toEqual([]);
    lifetime.unsubscribe();
  });

  it('emoticons maps only emoticon-usage shortcodes to their mxc', async () => {
    const { service } = setup({
      [STABLE]: {
        images: {
          wave: { url: 'mxc://hs/wave', usage: ['emoticon'] },
          both: { url: 'mxc://hs/both' },
          stick: { url: 'mxc://hs/stick', usage: ['sticker'] },
        },
      },
    });
    const lifetime = service.run().subscribe();
    await settle();

    expect([...service.emoticons()]).toEqual([
      ['wave', 'mxc://hs/wave'],
      ['both', 'mxc://hs/both'],
    ]);
    lifetime.unsubscribe();
  });

  it('fails with not-signed-in without an account', async () => {
    const { service } = setup({}, { active: null });

    const error = await codeOf(
      lastValueFrom(service.remove('a'), { defaultValue: undefined }),
    );

    expect(error.code).toBe('not-signed-in');
  });

  it('fails with not-signed-in while the active account has no running client', async () => {
    const { service, media } = setup({}, { active: BOB });
    media.uploadMedia.mockReturnValueOnce(
      throwError(
        () =>
          new EngineRequestError({
            kind: 'unexpected',
            code: 'account-not-live',
            diagnostic: { kind: 'unexpected' },
          }),
      ),
    );

    const removing = await codeOf(
      lastValueFrom(service.remove('a'), { defaultValue: undefined }),
    );
    const adding = await codeOf(
      firstValueFrom(service.add(existing('mxc://hs/a'), 'a', ['emoticon'])),
    );
    const uploading = await codeOf(
      firstValueFrom(
        service.add({ kind: 'file', file: png() }, 'b', ['emoticon']),
      ),
    );

    expect([removing.code, adding.code, uploading.code]).toEqual([
      'not-signed-in',
      'not-signed-in',
      'not-signed-in',
    ]);
  });

  it('sanitizes a file name into a shortcode', () => {
    expect(sanitizeShortcode('party parrot!.gif')).toBe('party_parrot_');
    expect(sanitizeShortcode('a'.repeat(120) + '.png')).toHaveLength(100);
  });
});

describe('ImagePackEditorService room packs', () => {
  const legacy = {
    pack: { display_name: 'Old pack' },
    images: { old: { url: 'mxc://hs/old' } },
  };

  /** A room pack on alice while bob is the active account. */
  function roomSetup(
    state: Record<string, Content> = {},
    { writable = true } = {},
  ) {
    const env = setup({}, { active: BOB });
    const roomId = env.engine.addRoom({
      name: 'Party room',
      writable,
      state: Object.entries(state).map(([type, content]) => ({
        type,
        state_key: '',
        content,
      })),
    });
    const ref = { kind: 'room', accountId: env.alice, roomId } as const;
    const sendState = vi.spyOn(env.engine, 'setRoomState');
    const sync = (type: string, content: Content) =>
      env.engine.setRoomState(env.alice, roomId, type, '', content).subscribe();
    return { ...env, roomId, ref, sendState, sync };
  }

  it('the first add keeps a legacy-only pack and writes the stable type on that account', async () => {
    const { service, alice, roomId, ref, sendState, media, write } = roomSetup({
      'im.ponies.room_emotes': legacy,
    });

    await firstValueFrom(
      service.add({ kind: 'file', file: png() }, 'wave', ['emoticon'], ref),
    );

    expect(sendState).toHaveBeenCalledOnce();
    const [account, room, type, key, content] = sendState.mock.calls[0];
    expect([account, room, type, key]).toEqual([
      alice,
      roomId,
      'm.room.image_pack',
      '',
    ]);
    expect(content).toEqual({
      pack: { display_name: 'Old pack' },
      images: {
        old: { url: 'mxc://hs/old' },
        wave: { url: 'mxc://hs/up1', info: UPLOAD_INFO, usage: ['emoticon'] },
      },
    });
    expect(media.uploadMedia.mock.calls[0][4]).toBe(alice);
    expect(write).not.toHaveBeenCalled();
  });

  it('names a new room pack after the room', async () => {
    const { service, ref, sendState } = roomSetup();
    await firstValueFrom(
      service.add(existing('mxc://hs/a'), 'a', ['sticker'], ref),
    );
    expect(sendState.mock.calls[0][4]).toMatchObject({
      pack: { display_name: 'Party room' },
    });
  });

  it('rename, setUsage and remove write the room pack', async () => {
    const { service, ref, sendState } = roomSetup({
      'm.room.image_pack': {
        pack: {},
        images: { a: { url: 'mxc://hs/a' }, b: { url: 'mxc://hs/b' } },
      },
    });
    await firstValueFrom(service.rename('a', 'c', ref));
    await firstValueFrom(service.setUsage('b', ['sticker'], ref));
    await firstValueFrom(service.remove('c', ref));
    expect(sendState.mock.calls.at(-1)?.[4]).toEqual({
      pack: { display_name: 'Party room' },
      images: { b: { url: 'mxc://hs/b', usage: ['sticker'] } },
    });
  });

  it('a pack the server finds too large is full', async () => {
    const { service, ref, sendState } = roomSetup();
    sendState.mockReturnValueOnce(
      of(
        engineFail({
          kind: 'http',
          code: 'too-large',
          diagnostic: { kind: 'http', httpStatus: 413, errcode: 'M_TOO_LARGE' },
        }),
      ),
    );
    const error = await codeOf(
      firstValueFrom(
        service.add(existing('mxc://hs/a'), 'a', ['sticker'], ref),
      ),
    );
    expect(error.code).toBe('pack-full');
  });

  it('a write the server forbids is not allowed', async () => {
    const { service, ref } = roomSetup({}, { writable: false });
    const error = await codeOf(
      firstValueFrom(
        service.add(existing('mxc://hs/a'), 'a', ['sticker'], ref),
      ),
    );
    expect(error.code).toBe('not-allowed');
  });

  it('fails with not-signed-in when the account is gone or has no running client', async () => {
    const { service, session, ref } = roomSetup();
    const gone = await codeOf(
      firstValueFrom(service.remove('a', { ...ref, accountId: '@gone:fake' })),
    );
    // Bob is signed in, but the fake runs no client for him.
    const notLive = await codeOf(
      firstValueFrom(service.remove('a', { ...ref, accountId: BOB })),
    );
    session.set(sessionWith(BOB, [BOB]));
    const signedOut = await codeOf(firstValueFrom(service.remove('a', ref)));
    expect([gone.code, notLive.code, signedOut.code]).toEqual([
      'not-signed-in',
      'not-signed-in',
      'not-signed-in',
    ]);
  });

  it('entries$ follows the room pack', async () => {
    const { service, ref, sync } = roomSetup({
      'm.room.image_pack': { pack: {}, images: { a: { url: 'mxc://hs/a' } } },
    });
    const seen: string[][] = [];
    const subscription = service
      .entries$(ref)
      .subscribe((entries) => seen.push(entries.map((e) => e.shortcode)));
    sync('m.room.image_pack', {
      pack: {},
      images: { a: { url: 'mxc://hs/a' }, b: { url: 'mxc://hs/b' } },
    });
    subscription.unsubscribe();
    sync('m.room.image_pack', { pack: {}, images: {} });
    expect(seen).toEqual([['a'], ['a', 'b']]);
  });
});
