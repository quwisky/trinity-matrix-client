import { TestBed } from '@angular/core/testing';
import { webcrypto } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaPipeline, MediaService } from '@trinity/data-access/media';
import { encryptAttachment } from '@trinity/util/matrix';
import { TimelineService } from './timeline.service';
import {
  fakeClient,
  fakeEvent,
  fakeRoom,
  matrixProvider,
  privacyProvider,
} from './timeline.spec-harness';

afterEach(() => {
  TestBed.resetTestingModule();
  vi.unstubAllGlobals();
});

it.each(['plaintext', 'encrypted'])(
  'resolves a retained %s Conversation image after repeated Workspace switches',
  async (encryption) => {
    vi.stubGlobal('crypto', webcrypto);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const encrypted =
      encryption === 'encrypted' ? await encryptAttachment(bytes.buffer) : null;
    const fetchBytes = vi.fn(
      async () => new Response(encrypted?.data ?? bytes),
    );
    vi.stubGlobal('fetch', fetchBytes);
    let issued = 0;
    const revoked: string[] = [];
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL(): string {
          return `blob:media-${++issued}`;
        }
        static override revokeObjectURL(url: string): void {
          revoked.push(url);
        }
      },
    );
    const roomA = fakeRoom([
      fakeEvent({
        id: '$image',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'photo.png',
        ...(encrypted
          ? { file: { ...encrypted.info, url: 'mxc://hs/photo' } }
          : { url: 'mxc://hs/photo' }),
        info: { mimetype: 'image/png' },
      }),
    ]);
    const roomB = fakeRoom([]);
    const client = {
      ...fakeClient(roomA, []),
      getRoom: (id: string) => (id === '!a:hs' ? roomA : roomB),
      isVersionSupported: async () => true,
      getAccessToken: () => 'account-token',
      mxcUrlToHttp: () => 'https://hs/media/photo',
    };
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        MediaPipeline,
        MediaService,
        matrixProvider(client),
        privacyProvider(true),
      ],
    });
    const a = TestBed.inject(TimelineService);
    const b = TestBed.runInInjectionContext(() => new TimelineService());
    const media = TestBed.inject(MediaPipeline);

    try {
      a.open('!a:hs');
      const original = a.messages()[0].media;
      if (!original) throw new Error('Image fixture was not projected');
      let url = await firstValueFrom(media.resolveMedia(original, 'thumbnail'));
      expect(url).toBe('blob:media-1');

      for (let switchCount = 0; switchCount < 3; switchCount++) {
        // Workspace releases view resources before Conversation Runtime changes focus.
        media.releaseAll();
        a.setVisible(false);
        if (switchCount === 0) b.open('!b:hs');
        else b.setVisible(true);
        expect(revoked).toContain(url);
        media.releaseAll();
        b.setVisible(false);
        a.setVisible(true);

        const returned = a.messages()[0].media;
        if (!returned) throw new Error('Returning image was not projected');
        url = await firstValueFrom(media.resolveMedia(returned, 'thumbnail'));
        expect(revoked).not.toContain(url);
        await expect(
          firstValueFrom(media.resolveMedia(returned, 'full')),
        ).resolves.toMatch(/^blob:media-/);
        await expect(
          firstValueFrom(media.downloadMedia(returned)),
        ).resolves.toMatchObject({ filename: 'photo.png', blob: { size: 4 } });
      }
    } finally {
      a.close();
      b.close();
      media.releaseAll();
    }
  },
);
