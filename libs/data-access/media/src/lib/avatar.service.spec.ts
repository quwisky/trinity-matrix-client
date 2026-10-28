import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, from, of, switchMap, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_SNAPSHOT } from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  engineFail,
  type EngineResult,
} from '@trinity/util/matrix';
import { FakeMediaEngine } from '../contract/fake-media-engine';
import { AvatarService } from './avatar.service';
import type { MediaContent, MediaRequest } from './media-engine';
import { MEDIA_ENGINE } from './media-engine.token';
import { MediaService } from './media.service';
import { sessionWith } from './media.spec-harness';
import { DEVICE_PIXEL_RATIO } from './thumbnail-size';
import {
  containsAscii,
  identifyingJpeg,
} from './image-metadata/image-metadata.fixture';

const ALICE = new FakeMediaEngine().alice;
const OWNER = '@owner:example.org';

const FAILED: Observable<EngineResult<MediaContent>> = of(
  engineFail({
    kind: 'network',
    code: 'request-failed',
    diagnostic: { kind: 'network' },
  }),
);

function setup(accounts?: readonly string[]) {
  const engine = new FakeMediaEngine();
  const realContent = engine.content.bind(engine);
  // Every avatar mxc exists unless a test fails its request.
  const content = vi
    .spyOn(engine, 'content')
    .mockImplementation((accountId: string, request: MediaRequest) => {
      if (request.source.kind === 'plain') {
        engine.put(request.source.mxc, new Uint8Array(8));
      }
      return realContent(accountId, request);
    });
  const release = vi.spyOn(engine, 'release');
  const upload = vi.spyOn(engine, 'upload');
  const session = signal(sessionWith(engine.alice, accounts ?? [engine.alice]));
  TestBed.configureTestingModule({
    providers: [
      AvatarService,
      MediaService,
      { provide: MEDIA_ENGINE, useValue: engine },
      { provide: SESSION_SNAPSHOT, useValue: session },
      { provide: DEVICE_PIXEL_RATIO, useValue: () => 1 },
    ],
  });
  return {
    svc: TestBed.inject(AvatarService),
    engine,
    content,
    upload,
    released: (): string[] => release.mock.calls.flatMap(([urls]) => urls),
    /** Hold the next `content` request; settle it with the real bytes or a failure. */
    park: () => {
      let settle!: (failed: boolean) => void;
      const gate = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
      content.mockImplementationOnce((accountId, request) =>
        from(gate).pipe(
          switchMap((failed) => {
            engine.put(
              (request.source as { mxc: string }).mxc,
              new Uint8Array(8),
            );
            return failed ? FAILED : realContent(accountId, request);
          }),
        ),
      );
      return { ok: () => settle(false), fail: () => settle(true) };
    },
  };
}

/** Mirrors the (non-exported) AVATAR_CACHE_LIMIT in avatar.service.ts. */
const CACHE_LIMIT = 256;

const tick = () => new Promise((resolve) => setTimeout(resolve));

describe('AvatarService', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('returns null for a missing avatar without fetching', async () => {
    const { svc, content } = setup();
    await expect(firstValueFrom(svc.resolve(null))).resolves.toBeNull();
    expect(content).not.toHaveBeenCalled();
  });

  it('uploads avatar bytes through the owning Account, in the clear', async () => {
    const { svc, engine, upload } = setup();
    const file = new File([new Uint8Array([1])], 'me.png', {
      type: 'image/png',
    });

    const mxc = await firstValueFrom(svc.upload(file, engine.alice));

    expect(upload.mock.calls[0]?.[0]).toBe(engine.alice);
    expect(upload.mock.calls[0]?.[2]).toEqual({
      filename: 'me.png',
      mimeType: 'image/png',
      encrypt: false,
    });
    await expect(engine.stored(mxc)).resolves.toEqual({
      filename: 'me.png',
      mimeType: 'image/png',
    });
  });

  it('uploads an avatar photo without its location, camera or capture time', async () => {
    const { svc, engine, upload } = setup();
    const photo = new File([identifyingJpeg(6)], 'me.jpg', {
      type: 'image/jpeg',
    });

    await firstValueFrom(svc.upload(photo, engine.alice));

    const body = upload.mock.calls[0]?.[1] as File;
    expect(body).not.toBe(photo);
    const sent = new Uint8Array(await body.arrayBuffer());
    expect(containsAscii(sent, '52.5200')).toBe(false);
    expect(containsAscii(sent, 'Canon')).toBe(false);
  });

  it('strips a profile photo even when photos sent in messages keep their metadata', async () => {
    const { svc, engine, upload } = setup();
    const photo = new File([identifyingJpeg(6)], 'me.jpg', {
      type: 'image/jpeg',
    });
    // The opt-in reaches Media only as a message attachment's upload policy (#1178).
    await firstValueFrom(
      TestBed.inject(MediaService).uploadMedia(
        photo,
        false,
        undefined,
        undefined,
        engine.alice,
        undefined,
        'keep',
      ),
    );
    expect(upload.mock.calls[0]?.[1]).toBe(photo);

    await firstValueFrom(svc.upload(photo, engine.alice));

    const avatar = upload.mock.calls[1]?.[1] as File;
    expect(avatar).not.toBe(photo);
    const sent = new Uint8Array(await avatar.arrayBuffer());
    expect(containsAscii(sent, '52.5200')).toBe(false);
    expect(containsAscii(sent, 'Canon')).toBe(false);
  });

  it('keeps avatar upload cold until subscribed', () => {
    const { svc, engine, upload } = setup();

    svc.upload(new File([], 'me.png'), engine.alice);

    expect(upload).not.toHaveBeenCalled();
  });

  it.each([
    [
      'over the upload limit',
      'too-large',
      (engine: FakeMediaEngine) => {
        engine.uploadLimitBytes = 1;
        return engine.alice;
      },
    ],
    [
      'for an account that is gone',
      'account-not-live',
      () => '@gone:example.org',
    ],
  ])('fails an avatar upload %s', async (_, code, prepare) => {
    const { svc, engine } = setup();
    const accountId = prepare(engine);

    const error = await firstValueFrom(
      svc.upload(new File([new Uint8Array(4)], 'me.png'), accountId),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as EngineRequestError).failure.code).toBe(code);
  });

  it('resolves a server thumbnail at twice the avatar size to an opaque URL', async () => {
    const { svc, engine, content } = setup();

    const url = await firstValueFrom(svc.resolve('mxc://hs/abc', 48));

    expect(engine.liveUrls()).toEqual([url]);
    expect(content).toHaveBeenCalledExactlyOnceWith(engine.alice, {
      source: { kind: 'plain', mxc: 'mxc://hs/abc' },
      format: {
        kind: 'thumbnail',
        width: 96,
        height: 96,
        method: 'scale',
        animated: false,
      },
      mimeType: 'application/octet-stream',
      downscaleTo: null,
    });
  });

  it('caches per mxc+size so re-resolving does not refetch', async () => {
    const { svc, content } = setup();

    const a = await firstValueFrom(svc.resolve('mxc://hs/abc', 64));
    const b = await firstValueFrom(svc.resolve('mxc://hs/abc', 64));

    expect(a).toBe(b);
    expect(content).toHaveBeenCalledTimes(1);
  });

  it('falls back to null when the avatar fetch fails', async () => {
    const { svc, content } = setup();
    content.mockReturnValueOnce(FAILED);

    await expect(
      firstValueFrom(svc.resolve('mxc://hs/missing')),
    ).resolves.toBeNull();
  });

  it('does not cache a failure for good — a later resolve retries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { svc, content } = setup();
    content.mockReturnValueOnce(FAILED);
    await expect(
      firstValueFrom(svc.resolve('mxc://hs/blip')),
    ).resolves.toBeNull();

    // Network recovers. Past the cooldown the avatar must refetch, not replay null —
    // a failure is never allowed to pin someone to initials for the whole session.
    vi.setSystemTime(Date.now() + 30_000);
    await expect(firstValueFrom(svc.resolve('mxc://hs/blip'))).resolves.toMatch(
      /^blob:/,
    );
    expect(content).toHaveBeenCalledTimes(2);
  });

  it('does not re-attempt a failed avatar until its cooldown expires', async () => {
    // Rows are recreated constantly as a list scrolls, and each recreation re-resolves.
    // Without a cooldown every one of those starts a fresh request — which, offline, is
    // a stampede against a network that is not there.
    const { svc, content } = setup();
    content.mockReturnValue(FAILED);
    await expect(
      firstValueFrom(svc.resolve('mxc://hs/offline')),
    ).resolves.toBeNull();

    // Five more rows ask for the same avatar while still offline. Subscribed rather
    // than awaited: a cooled-down key answers synchronously, while a regression would
    // start a request on subscribe.
    const seen: (string | null)[] = [];
    for (let i = 0; i < 5; i++) {
      svc.resolve('mxc://hs/offline').subscribe((url) => seen.push(url));
    }

    expect(content).toHaveBeenCalledTimes(1); // not one extra request
    expect(seen).toEqual([null, null, null, null, null]); // and each got its initial
  });

  describe('bounded cache', () => {
    async function fill(svc: AvatarService, count: number, from = 0) {
      const urls: string[] = [];
      for (let i = from; i < from + count; i++) {
        urls.push((await firstValueFrom(svc.resolve(`mxc://hs/${i}`)))!);
      }
      return urls;
    }

    it('releases the least recently used URL once the cap is exceeded', async () => {
      const { svc, released } = setup();
      const urls = await fill(svc, CACHE_LIMIT + 1);

      expect(released()).toEqual([urls[0]]);
    });

    it('evicts in recency order: a re-resolved key outlives an older one', async () => {
      const { svc, released } = setup();
      const urls = await fill(svc, CACHE_LIMIT);
      await firstValueFrom(svc.resolve('mxc://hs/0')); // touch the oldest
      await fill(svc, 1, CACHE_LIMIT);

      expect(released()).toEqual([urls[1]]);
    });

    it('never releases a URL a live subscriber is still showing', async () => {
      const { svc, released } = setup();
      const shown: (string | null)[] = [];
      const sub = svc.resolve('mxc://hs/0').subscribe((u) => shown.push(u));
      await tick();
      await fill(svc, CACHE_LIMIT + 5, 1);

      expect(released()).not.toContain(shown[0]);

      // Once the row is gone the URL becomes evictable again.
      sub.unsubscribe();
      await fill(svc, 1, CACHE_LIMIT + 10);
      expect(released()).toContain(shown[0]);
    });

    it('re-resolves an evicted key with a fresh request and URL', async () => {
      const { svc, content } = setup();
      const urls = await fill(svc, CACHE_LIMIT + 1);
      content.mockClear();

      const again = await firstValueFrom(svc.resolve('mxc://hs/0'));

      expect(content).toHaveBeenCalledTimes(1);
      expect(again).not.toBe(urls[0]);
    });
  });

  describe('requests that land after releaseAll', () => {
    it('leaves no URL behind that nobody can release', async () => {
      const { svc, engine, park } = setup();
      const late = park();
      const seen: (string | null)[] = [];
      svc.resolve('mxc://hs/slow').subscribe((u) => seen.push(u));
      svc.releaseAll();

      late.ok();
      await tick();

      expect(engine.liveUrls()).toEqual([]);
      expect(seen).toEqual([null]);
    });

    it('does not let a late failure delete or cool down the newer entry', async () => {
      const { svc, content, park } = setup();
      const stale = park();
      svc.resolve('mxc://hs/slow').subscribe();
      svc.releaseAll();
      // Re-resolve in between: a new entry for the same key.
      const fresh: (string | null)[] = [];
      svc.resolve('mxc://hs/slow').subscribe((u) => fresh.push(u));
      await tick();
      expect(fresh).toEqual([expect.stringMatching(/^blob:/)]);

      stale.fail();
      await tick();

      // Still cached (no refetch) and not cooling down.
      content.mockClear();
      const again: (string | null)[] = [];
      svc.resolve('mxc://hs/slow').subscribe((u) => again.push(u));
      await tick();
      expect(again).toEqual(fresh);
      expect(content).not.toHaveBeenCalled();
    });
  });

  it('releaseAll releases every cached avatar URL and clears the cache', async () => {
    const { svc, content, released } = setup();
    const url = await firstValueFrom(svc.resolve('mxc://hs/abc'));

    svc.releaseAll();
    expect(released()).toEqual([url]);

    // Cache cleared → the same avatar is requested again.
    await firstValueFrom(svc.resolve('mxc://hs/abc'));
    expect(content).toHaveBeenCalledTimes(2);
  });

  it('releaseUnpinned releases only avatars no subscriber is showing', async () => {
    const { svc, content, released } = setup();
    let shownUrl: string | null = null;
    const shown = svc.resolve('mxc://hs/shown').subscribe((url) => {
      shownUrl = url;
    });
    await vi.waitFor(() => expect(shownUrl).not.toBeNull());
    const unused = await firstValueFrom(svc.resolve('mxc://hs/unused'));
    content.mockClear();

    svc.releaseUnpinned();

    expect(released()).toEqual([unused]);
    // The held avatar is still cached; the released one is requested again.
    await expect(firstValueFrom(svc.resolve('mxc://hs/shown'))).resolves.toBe(
      shownUrl,
    );
    expect(content).not.toHaveBeenCalled();
    await firstValueFrom(svc.resolve('mxc://hs/unused'));
    expect(content).toHaveBeenCalledTimes(1);
    shown.unsubscribe();
  });
});

// In the mixed-account view a row can belong to a signed-in account that isn't active.
// Resolving its media through the ACTIVE account would ask one homeserver for another
// identity's media — leaking the association, and failing outright where the two servers
// don't federate media to each other.
describe('AvatarService per-account resolution', () => {
  afterEach(() => TestBed.resetTestingModule());

  const accountsOf = (content: ReturnType<typeof setup>['content']) =>
    content.mock.calls.map(([accountId]) => accountId);

  it('resolves through the owning account, not the active one', async () => {
    const { svc, content } = setup([ALICE, OWNER]);

    await firstValueFrom(svc.resolve('mxc://hs/a', 40, OWNER));

    expect(accountsOf(content)).toEqual([OWNER]);
  });

  it('still uses the active account when no account is named', async () => {
    const { svc, content, engine } = setup();

    await firstValueFrom(svc.resolve('mxc://hs/a', 40));

    expect(accountsOf(content)).toEqual([engine.alice]);
  });

  // The same mxc through a different homeserver is a different request, so it must not
  // share a cache entry — that would defeat the routing above.
  it('caches per account rather than by mxc alone', async () => {
    const { svc, content, engine } = setup([ALICE, OWNER]);

    await firstValueFrom(svc.resolve('mxc://hs/a', 40, OWNER));
    await firstValueFrom(svc.resolve('mxc://hs/a', 40));

    expect(accountsOf(content)).toEqual([OWNER, engine.alice]);
  });

  it('falls back to the active account when the named account is not live', async () => {
    const { svc, content, engine } = setup();

    await firstValueFrom(svc.resolve('mxc://hs/a', 40, '@gone:example.org'));

    expect(accountsOf(content)).toEqual([engine.alice]);
  });
});
