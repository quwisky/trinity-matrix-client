import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  MatrixClientService,
  SESSION_SNAPSHOT,
} from '@trinity/data-access/matrix-client';
import { UrlPreviewService } from './url-preview.service';

const ALICE = '@alice:hs';
const BOB = '@bob:hs';

function setup(
  getUrlPreview = vi.fn(),
  rooms: {
    stateEncrypted?: boolean;
    crypto?: { isEncryptionEnabledInRoom: () => Promise<boolean> } | null;
    /** The active account; null when nobody is signed in. */
    activeAccountId?: string | null;
  } = {},
) {
  const crypto =
    rooms.crypto === undefined
      ? { isEncryptionEnabledInRoom: () => Promise.resolve(false) }
      : rooms.crypto;
  const instance = {
    getUrlPreview,
    getRoom: (roomId: string) =>
      roomId === '!r:hs'
        ? {
            roomId,
            hasEncryptionStateEvent: () => rooms.stateEncrypted ?? false,
          }
        : null,
    getCrypto: () => crypto ?? undefined,
  };
  const bobGetUrlPreview = vi.fn().mockResolvedValue({ 'og:title': 'Bob' });
  const bob = { ...instance, getUrlPreview: bobGetUrlPreview };
  const session = signal({
    ...EMPTY_SESSION,
    activeAccountId:
      rooms.activeAccountId === undefined ? ALICE : rooms.activeAccountId,
  });
  TestBed.configureTestingModule({
    providers: [
      UrlPreviewService,
      MockProvider(MatrixClientService, {
        clientFor: (accountId: string) =>
          accountId === ALICE
            ? (instance as never)
            : accountId === BOB
              ? (bob as never)
              : null,
      }),
      { provide: SESSION_SNAPSHOT, useValue: session },
    ],
  });
  return {
    svc: TestBed.inject(UrlPreviewService),
    getUrlPreview,
    bobGetUrlPreview,
    session,
  };
}

describe('UrlPreviewService', () => {
  it('maps the OG response to a preview', async () => {
    const { svc, getUrlPreview } = setup(
      vi.fn().mockResolvedValue({
        'og:title': 'Example',
        'og:description': 'A site',
        'og:image': 'mxc://hs/img',
      }),
    );

    expect(await firstValueFrom(svc.preview('https://example.com'))).toEqual({
      url: 'https://example.com',
      title: 'Example',
      description: 'A site',
      imageMxc: 'mxc://hs/img',
    });
    expect(getUrlPreview).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(Number),
    );
  });

  it('returns null when the response has no title, description, or image', async () => {
    const { svc } = setup(vi.fn().mockResolvedValue({ 'og:type': 'website' }));
    expect(await firstValueFrom(svc.preview('https://x.test'))).toBeNull();
  });

  it('returns null when the preview request fails (e.g. previews disabled)', async () => {
    const { svc } = setup(vi.fn().mockRejectedValue(new Error('disabled')));
    expect(await firstValueFrom(svc.preview('https://x.test'))).toBeNull();
  });

  it('caches per URL — a second subscription does not refetch', async () => {
    const { svc, getUrlPreview } = setup(
      vi.fn().mockResolvedValue({ 'og:title': 'Example' }),
    );

    await firstValueFrom(svc.preview('https://example.com'));
    await firstValueFrom(svc.preview('https://example.com'));

    expect(getUrlPreview).toHaveBeenCalledTimes(1);
  });

  it('bounds the cache — the oldest entry is evicted past the limit', async () => {
    const getUrlPreview = vi.fn(async (url: string) => ({ 'og:title': url }));
    const { svc } = setup(getUrlPreview);

    // Resolve well over the cap so eviction runs.
    for (let i = 0; i < 300; i++) {
      await firstValueFrom(svc.preview(`https://x.test/${i}`));
    }
    getUrlPreview.mockClear();

    // The oldest URL was evicted, so it re-fetches instead of returning a cached hit.
    await firstValueFrom(svc.preview('https://x.test/0'));
    expect(getUrlPreview).toHaveBeenCalledWith(
      'https://x.test/0',
      expect.any(Number),
    );
  });

  it('does not cache a transient failure — a later view retries and can render', async () => {
    const getUrlPreview = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary')) // first view: homeserver hiccup
      .mockResolvedValueOnce({ 'og:title': 'Recovered' }); // later view: OK
    const { svc } = setup(getUrlPreview);

    expect(await firstValueFrom(svc.preview('https://x.test'))).toBeNull();
    // The failure must not be cached, so the card can appear once the server recovers.
    expect(await firstValueFrom(svc.preview('https://x.test'))).toEqual({
      url: 'https://x.test',
      title: 'Recovered',
      description: null,
      imageMxc: null,
    });
    expect(getUrlPreview).toHaveBeenCalledTimes(2);
  });

  it('asks nothing when nobody is signed in', async () => {
    const { svc, getUrlPreview } = setup(
      vi.fn().mockResolvedValue({ 'og:title': 'Example' }),
      { activeAccountId: null },
    );

    expect(await firstValueFrom(svc.preview('https://example.com'))).toBeNull();
    expect(getUrlPreview).not.toHaveBeenCalled();
  });

  it('follows the active account', async () => {
    const { svc, getUrlPreview, bobGetUrlPreview, session } = setup(
      vi.fn().mockResolvedValue({ 'og:title': 'Example' }),
      { activeAccountId: BOB },
    );

    // Bob's homeserver answers for Bob; nothing reaches Alice's.
    expect(
      await firstValueFrom(svc.preview('https://example.com/bob')),
    ).toMatchObject({ title: 'Bob' });
    expect(bobGetUrlPreview).toHaveBeenCalledOnce();
    expect(getUrlPreview).not.toHaveBeenCalled();

    session.set({ ...EMPTY_SESSION, activeAccountId: ALICE });
    expect(
      await firstValueFrom(svc.preview('https://example.com/alice')),
    ).toMatchObject({ title: 'Example' });
    expect(getUrlPreview).toHaveBeenCalledOnce();
    expect(bobGetUrlPreview).toHaveBeenCalledOnce();
  });

  // `preview` is the encrypted-rooms opt-in path: the caller has already allowed it.
  it('previews a link from an encrypted room once the caller allows it', async () => {
    const { svc, getUrlPreview } = setup(
      vi.fn().mockResolvedValue({ 'og:title': 'Example' }),
      { stateEncrypted: true },
    );

    expect(
      await firstValueFrom(svc.preview('https://example.com')),
    ).toMatchObject({ title: 'Example' });
    expect(getUrlPreview).toHaveBeenCalledOnce();
  });

  describe('supported', () => {
    it('starts unknown (null) before any request', () => {
      expect(setup().svc.supported()).toBeNull();
    });

    it('becomes true once the endpoint answers (even with empty OG)', async () => {
      const { svc } = setup(
        vi.fn().mockResolvedValue({ 'og:type': 'website' }),
      );
      await firstValueFrom(svc.preview('https://x.test'));
      expect(svc.supported()).toBe(true);
    });

    it('becomes false when the endpoint is unrecognised (previews disabled)', async () => {
      const { svc } = setup(
        vi
          .fn()
          .mockRejectedValue({ errcode: 'M_UNRECOGNIZED', httpStatus: 404 }),
      );
      await firstValueFrom(svc.preview('https://x.test'));
      expect(svc.supported()).toBe(false);
    });

    it('stays unknown when a preview is refused without asking', async () => {
      const { svc } = setup(vi.fn(), { stateEncrypted: true });
      await firstValueFrom(svc.previewIfUnencrypted('https://x.test', '!r:hs'));
      expect(svc.supported()).toBeNull();
    });

    it('stays unknown on a transient error (does not falsely report unsupported)', async () => {
      const { svc } = setup(vi.fn().mockRejectedValue(new Error('temporary')));
      await firstValueFrom(svc.preview('https://x.test'));
      expect(svc.supported()).toBeNull();
    });
  });

  describe('previewIfUnencrypted', () => {
    const ok = () => vi.fn().mockResolvedValue({ 'og:title': 'Example' });

    it('fetches once the room state and the crypto store both say unencrypted', async () => {
      const { svc, getUrlPreview } = setup(ok());

      expect(
        await firstValueFrom(
          svc.previewIfUnencrypted('https://example.com', '!r:hs'),
        ),
      ).toMatchObject({ title: 'Example' });
      expect(getUrlPreview).toHaveBeenCalled();
    });

    it('does not ask the homeserver for a room the crypto store has as encrypted when its state lacks the event', async () => {
      const { svc, getUrlPreview } = setup(ok(), {
        crypto: { isEncryptionEnabledInRoom: () => Promise.resolve(true) },
      });

      expect(
        await firstValueFrom(
          svc.previewIfUnencrypted('https://example.com', '!r:hs'),
        ),
      ).toBeNull();
      expect(getUrlPreview).not.toHaveBeenCalled();
    });

    it('does not ask the homeserver when the crypto store is unavailable', async () => {
      const { svc, getUrlPreview } = setup(ok(), { crypto: null });

      expect(
        await firstValueFrom(
          svc.previewIfUnencrypted('https://example.com', '!r:hs'),
        ),
      ).toBeNull();
      expect(getUrlPreview).not.toHaveBeenCalled();
    });

    it('does not ask the homeserver for a message without a room', async () => {
      const { svc, getUrlPreview } = setup(ok());

      expect(
        await firstValueFrom(
          svc.previewIfUnencrypted('https://example.com', null),
        ),
      ).toBeNull();
      expect(getUrlPreview).not.toHaveBeenCalled();
    });

    it('caches a cleared preview for its room only', async () => {
      const { svc, getUrlPreview } = setup(ok());

      await firstValueFrom(
        svc.previewIfUnencrypted('https://example.com', '!r:hs'),
      );
      await firstValueFrom(
        svc.previewIfUnencrypted('https://example.com', '!r:hs'),
      );
      expect(getUrlPreview).toHaveBeenCalledTimes(1);

      // Another room is checked on its own, and this one cannot be found.
      expect(
        await firstValueFrom(
          svc.previewIfUnencrypted('https://example.com', '!gone:hs'),
        ),
      ).toBeNull();
      expect(getUrlPreview).toHaveBeenCalledTimes(1);
    });

    it('does not ask the homeserver for a room it cannot find', async () => {
      const { svc, getUrlPreview } = setup(ok());

      for (const roomId of ['!gone:hs', null]) {
        expect(
          await firstValueFrom(
            svc.previewIfUnencrypted('https://example.com', roomId),
          ),
        ).toBeNull();
      }
      expect(getUrlPreview).not.toHaveBeenCalled();
    });

    it('does not serve a cached preview to a room that turned out encrypted', async () => {
      const { svc, getUrlPreview } = setup(ok(), { stateEncrypted: true });
      await firstValueFrom(svc.preview('https://example.com'));

      expect(
        await firstValueFrom(
          svc.previewIfUnencrypted('https://example.com', '!r:hs'),
        ),
      ).toBeNull();
      expect(getUrlPreview).toHaveBeenCalledTimes(1);
    });
  });
});
