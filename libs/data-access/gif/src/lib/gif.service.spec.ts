import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GifService } from './gif.service';
import { GifSettingsService } from './gif-settings.service';
import type { GifResult } from './gif.model';

const prefs = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: prefs,
}));

const gif: GifResult = {
  id: '1',
  description: 'Happy Cat',
  previewUrl: 'https://x/tiny',
  previewWidth: 1,
  previewHeight: 1,
  url: 'https://x/gif',
  width: 2,
  height: 2,
};

describe('GifService', () => {
  let gifs: GifService;
  let settings: GifSettingsService;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    prefs.set.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    // jsdom has no object-URL API; the preview path binds bytes as a blob URL.
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    TestBed.configureTestingModule({});
    gifs = TestBed.inject(GifService);
    settings = TestBed.inject(GifSettingsService);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns [] without querying when no key is configured', async () => {
    const out = await firstValueFrom(gifs.search('cat'));
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('searches the configured provider and normalizes the results', async () => {
    settings.save('klipy', 'KEY');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            id: '1',
            content_description: 'cat',
            media_formats: {
              gif: { url: 'https://x/gif', dims: [200, 100] },
              tinygif: { url: 'https://x/tiny', dims: [100, 50] },
            },
          },
        ],
      }),
    });
    const out = await firstValueFrom(gifs.search('cat'));
    expect(fetchMock).toHaveBeenCalledOnce();
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('api.klipy.com');
    expect(calledUrl).toContain('q=cat');
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://x/gif');
  });

  it('falls back to trending for a blank query', async () => {
    settings.save('klipy', 'KEY');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    await firstValueFrom(gifs.search('   '));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v2/featured');
  });

  it('throws when the search response is not ok', async () => {
    settings.save('klipy', 'KEY');
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(firstValueFrom(gifs.search('cat'))).rejects.toThrow(/403/);
  });

  it('download() fetches the gif url and wraps it as a named image/gif File', async () => {
    const blob = new Blob(['bytes'], { type: 'image/gif' });
    fetchMock.mockResolvedValue({ ok: true, blob: async () => blob });
    const file = await firstValueFrom(gifs.download(gif));
    expect(fetchMock).toHaveBeenCalledWith('https://x/gif');
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe('image/gif');
    expect(file.name).toBe('happy-cat.gif');
  });

  it('download() rejects when the gif url is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(firstValueFrom(gifs.download(gif))).rejects.toThrow(/404/);
  });

  it('fetchPreview() fetches the bytes and binds them as a blob object URL', async () => {
    const blob = new Blob(['bytes'], { type: 'image/gif' });
    fetchMock.mockResolvedValue({ ok: true, blob: async () => blob });
    const objectUrl = await firstValueFrom(gifs.fetchPreview('https://x/tiny'));
    expect(fetchMock).toHaveBeenCalledWith('https://x/tiny');
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(objectUrl).toBe('blob:preview');
  });
});
