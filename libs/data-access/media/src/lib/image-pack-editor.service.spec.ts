import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ClientEvent, MatrixError, type Method } from 'matrix-js-sdk';
import { firstValueFrom, lastValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('./image-pack-image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./image-pack-image')>()),
  prepareImagePackImage: vi.fn(async (file: File) => file),
}));

type Content = Record<string, unknown>;

const STABLE = PERSONAL_IMAGE_PACK_EVENT_TYPE;
const LEGACY = LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE;
const UPLOAD_INFO = { mimetype: 'image/png', size: 4, w: 64, h: 64 };

function accountEvent(type: string, content: unknown) {
  return { getType: () => type, getContent: () => content };
}

function fakeClient(userId: string, local: Record<string, Content>) {
  const store: Record<string, Content> = structuredClone(local);
  const server: Record<string, Content> = structuredClone(local);
  const listeners = new Set<(event: unknown) => void>();
  // Like the SDK's raw write: the local store only changes when sync echoes it.
  const write = vi.fn(async (type: string, content: Content) => {
    server[type] = structuredClone(content);
  });
  const client = {
    getUserId: () => userId,
    getAccountData: (type: string) =>
      store[type] ? accountEvent(type, store[type]) : undefined,
    setAccountDataRaw: write,
    http: {
      authedRequest: vi.fn(async (_method: Method, path: string) => {
        const type = decodeURIComponent(path.split('/').at(-1) ?? '');
        if (!server[type]) {
          throw new MatrixError({ errcode: 'M_NOT_FOUND' }, 404);
        }
        return structuredClone(server[type]);
      }),
    },
    on: vi.fn((name: string, listener: (event: unknown) => void) => {
      if (name === ClientEvent.AccountData) listeners.add(listener);
    }),
    off: vi.fn((_name: string, listener: (event: unknown) => void) =>
      listeners.delete(listener),
    ),
  };
  /** A sync event; `stale` leaves the server copy alone, as a response computed earlier does. */
  const sync = (type: string, content: Content, { stale = false } = {}) => {
    store[type] = content;
    if (!stale) server[type] = content;
    for (const listener of listeners) listener(accountEvent(type, content));
  };
  return { client, write, sync };
}

function setup(local: Record<string, Content> = {}) {
  const activeUserId = signal<string | null>('@alice:hs');
  const { client, write, sync } = fakeClient('@alice:hs', local);
  const matrix: {
    isInitialized: boolean;
    instance: unknown;
    activeUserId: unknown;
  } = {
    isInitialized: true,
    instance: client,
    activeUserId: activeUserId.asReadonly(),
  };
  let uploads = 0;
  const media = {
    uploadMedia: vi.fn(() => {
      uploads += 1;
      return of({ mxc: `mxc://hs/up${uploads}`, info: UPLOAD_INFO });
    }),
    uploadLimit: vi.fn(() => of<number | null>(null)),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: MatrixClientService, useValue: matrix },
      { provide: MediaService, useValue: media },
    ],
  });
  const service = TestBed.inject(ImagePackEditorService);
  const written = () => write.mock.calls.at(-1)?.[1];
  return { service, client, matrix, activeUserId, media, write, written, sync };
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
    const { service, media, write } = setup();
    const file = png();

    const entry = await firstValueFrom(
      service.add({ kind: 'file', file }, 'wave', ['sticker']),
    );

    expect(prepareImagePackImage).toHaveBeenCalledWith(file, ['sticker']);
    expect(media.uploadMedia.mock.calls[0]).toEqual(
      expect.arrayContaining([file, false]),
    );
    expect(write).toHaveBeenCalledWith(STABLE, {
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
    const { service, written, sync } = setup();
    await firstValueFrom(
      service.add(existing('mxc://hs/a'), 'a', ['emoticon']),
    );
    await firstValueFrom(
      service.add(existing('mxc://hs/b'), 'b', ['emoticon']),
    );

    sync(STABLE, { images: { a: { url: 'mxc://hs/a' } } }, { stale: true });
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
    const { service, written, sync } = setup({
      [LEGACY]: { images: { old: { url: 'mxc://hs/old' } } },
    });
    await firstValueFrom(
      service.add(existing('mxc://hs/a'), 'a', ['emoticon']),
    );

    sync(LEGACY, { images: { old: { url: 'mxc://hs/old' } } }, { stale: true });
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
    write.mockRejectedValueOnce(new Error('offline'));

    await expect(
      firstValueFrom(service.add({ kind: 'file', file }, 'wave', ['emoticon'])),
    ).rejects.toThrow('offline');
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
    const { service, write } = setup({
      [LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE]: legacy,
    });

    await firstValueFrom(
      service.add({ kind: 'existing', url: 'mxc://hs/new' }, 'new', [
        'emoticon',
      ]),
    );

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(STABLE, {
      pack: legacy.pack,
      images: {
        ...legacy.images,
        new: { url: 'mxc://hs/new', usage: ['emoticon'] },
      },
    });
  });

  it('personal follows the pack and the active account, and is null signed out', async () => {
    const { service, matrix, activeUserId, sync } = setup({
      [STABLE]: { images: { a: { url: 'mxc://hs/a' } } },
    });
    expect(service.personal()).toBeNull();

    const lifetime = service.run().subscribe();
    TestBed.tick();
    expect(service.personal()?.map((entry) => entry.shortcode)).toEqual(['a']);

    sync(STABLE, { images: { b: { url: 'mxc://hs/b' } } });
    await vi.waitFor(() =>
      expect(service.personal()?.map((entry) => entry.shortcode)).toEqual([
        'b',
      ]),
    );

    matrix.instance = fakeClient('@bob:hs', {
      [STABLE]: { images: { bobs: { url: 'mxc://hs/bob' } } },
    }).client;
    activeUserId.set('@bob:hs');
    TestBed.tick();
    expect(service.personal()?.map((entry) => entry.shortcode)).toEqual([
      'bobs',
    ]);

    matrix.isInitialized = false;
    activeUserId.set(null);
    TestBed.tick();
    expect(service.personal()).toBeNull();
    lifetime.unsubscribe();
  });

  it('fails with not-signed-in without an account', async () => {
    const { service, matrix } = setup();
    matrix.isInitialized = false;

    const error = await codeOf(
      lastValueFrom(service.remove('a'), { defaultValue: undefined }),
    );

    expect(error.code).toBe('not-signed-in');
  });

  it('sanitizes a file name into a shortcode', () => {
    expect(sanitizeShortcode('party parrot!.gif')).toBe('party_parrot_');
    expect(sanitizeShortcode('a'.repeat(120) + '.png')).toHaveLength(100);
  });
});
