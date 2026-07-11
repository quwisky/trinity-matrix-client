import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { UrlPreviewService } from './url-preview.service';

function setup(getUrlPreview = vi.fn()) {
  const instance = { getUrlPreview };
  TestBed.configureTestingModule({
    providers: [
      UrlPreviewService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: instance as never,
      }),
    ],
  });
  return { svc: TestBed.inject(UrlPreviewService), getUrlPreview };
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
});
