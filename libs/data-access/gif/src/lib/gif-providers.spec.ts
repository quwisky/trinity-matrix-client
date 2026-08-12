import { describe, expect, it } from 'vitest';
import { buildGifRequestUrl, parseGifResults } from './gif-providers';

describe('buildGifRequestUrl', () => {
  it('builds a KLIPY search URL with key, query and gif filters', () => {
    const url = new URL(buildGifRequestUrl('klipy', 'cat', 'KEY', 24));
    expect(url.origin + url.pathname).toBe('https://api.klipy.com/v2/search');
    expect(url.searchParams.get('q')).toBe('cat');
    expect(url.searchParams.get('key')).toBe('KEY');
    expect(url.searchParams.get('limit')).toBe('24');
    expect(url.searchParams.get('media_filter')).toContain('gif');
    expect(url.searchParams.get('contentfilter')).toBe('high');
    // Tenor's registered-app identifier; KLIPY authenticates on `key` alone, so carrying
    // it over would send a parameter naming a service we no longer talk to.
    expect(url.searchParams.has('client_key')).toBe(false);
  });

  it('targets the KLIPY featured feed when the query is null', () => {
    const url = new URL(buildGifRequestUrl('klipy', null, 'KEY', 24));
    expect(url.pathname).toBe('/v2/featured');
    expect(url.searchParams.has('q')).toBe(false);
  });

  it('builds a Giphy search URL with api_key, query and rating', () => {
    const url = new URL(buildGifRequestUrl('giphy', 'dog', 'KEY', 12));
    expect(url.origin + url.pathname).toBe(
      'https://api.giphy.com/v1/gifs/search',
    );
    expect(url.searchParams.get('q')).toBe('dog');
    expect(url.searchParams.get('api_key')).toBe('KEY');
    expect(url.searchParams.get('limit')).toBe('12');
    expect(url.searchParams.get('rating')).toBe('pg-13');
  });

  it('targets the Giphy trending feed when the query is null', () => {
    const url = new URL(buildGifRequestUrl('giphy', null, 'KEY', 12));
    expect(url.pathname).toBe('/v1/gifs/trending');
    expect(url.searchParams.has('q')).toBe(false);
  });
});

describe('parseGifResults', () => {
  it('normalizes KLIPY results and skips items missing a gif url', () => {
    const body = {
      results: [
        {
          id: '1',
          content_description: 'a cat',
          media_formats: {
            gif: { url: 'https://x/gif', dims: [200, 100] },
            tinygif: { url: 'https://x/tiny', dims: [100, 50] },
          },
        },
        // Missing the full `gif` format → dropped.
        { id: '2', media_formats: { tinygif: { url: 'https://x/only-tiny' } } },
      ],
    };
    const out = parseGifResults('klipy', body);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: '1',
      description: 'a cat',
      url: 'https://x/gif',
      previewUrl: 'https://x/tiny',
      width: 200,
      height: 100,
      previewWidth: 100,
      previewHeight: 50,
    });
  });

  it('falls back to the full gif as its own preview when tinygif is absent', () => {
    const out = parseGifResults('klipy', {
      results: [
        {
          id: '3',
          media_formats: { gif: { url: 'https://x/g', dims: [1, 1] } },
        },
      ],
    });
    expect(out[0].previewUrl).toBe('https://x/g');
  });

  it('normalizes Giphy results, coercing string dimensions to numbers', () => {
    const body = {
      data: [
        {
          id: 'g1',
          title: 'a dog',
          images: {
            original: { url: 'https://x/orig', width: '480', height: '270' },
            fixed_width: { url: 'https://x/fw', width: '200', height: '112' },
          },
        },
      ],
    };
    const out = parseGifResults('giphy', body);
    expect(out[0]).toMatchObject({
      id: 'g1',
      description: 'a dog',
      url: 'https://x/orig',
      previewUrl: 'https://x/fw',
      width: 480,
      height: 270,
      previewWidth: 200,
      previewHeight: 112,
    });
  });

  it('returns [] for a malformed or empty body', () => {
    expect(parseGifResults('klipy', null)).toEqual([]);
    expect(parseGifResults('klipy', {})).toEqual([]);
    expect(parseGifResults('giphy', { data: 'nope' })).toEqual([]);
  });
});
