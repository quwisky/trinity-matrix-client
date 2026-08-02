import type { GifProviderId, GifResult } from './gif.model';

const TENOR_BASE = 'https://tenor.googleapis.com/v2';
const GIPHY_BASE = 'https://api.giphy.com/v1/gifs';

/**
 * Build a provider's request URL. A null `query` targets the trending/featured
 * feed; a non-null query targets search. Results are content-filtered to a safe
 * rating and capped at `limit`.
 */
export function buildGifRequestUrl(
  provider: GifProviderId,
  query: string | null,
  apiKey: string,
  limit: number,
): string {
  if (provider === 'tenor') {
    const params = new URLSearchParams({
      key: apiKey,
      client_key: 'trinity',
      limit: String(limit),
      media_filter: 'gif,tinygif',
      contentfilter: 'high',
    });
    if (query) {
      params.set('q', query);
    }
    return `${TENOR_BASE}/${query ? 'search' : 'featured'}?${params.toString()}`;
  }
  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(limit),
    rating: 'pg-13',
  });
  if (query) {
    params.set('q', query);
    params.set('bundle', 'messaging_non_clips');
  }
  return `${GIPHY_BASE}/${query ? 'search' : 'trending'}?${params.toString()}`;
}

/** Normalize a provider's JSON body into GifResults, dropping malformed items. */
export function parseGifResults(
  provider: GifProviderId,
  body: unknown,
): GifResult[] {
  return provider === 'tenor' ? parseTenor(body) : parseGiphy(body);
}

interface TenorFormat {
  url?: string;
  dims?: number[];
}
interface TenorItem {
  id?: string;
  content_description?: string;
  media_formats?: { gif?: TenorFormat; tinygif?: TenorFormat };
}

function parseTenor(body: unknown): GifResult[] {
  const results = (body as { results?: TenorItem[] } | null)?.results;
  if (!Array.isArray(results)) {
    return [];
  }
  const out: GifResult[] = [];
  for (const item of results) {
    const gif = item.media_formats?.gif;
    const preview = item.media_formats?.tinygif ?? gif;
    if (!item.id || !gif?.url || !preview?.url) {
      continue;
    }
    out.push({
      id: item.id,
      description: item.content_description ?? '',
      previewUrl: preview.url,
      previewWidth: preview.dims?.[0] ?? 0,
      previewHeight: preview.dims?.[1] ?? 0,
      url: gif.url,
      width: gif.dims?.[0] ?? 0,
      height: gif.dims?.[1] ?? 0,
    });
  }
  return out;
}

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}
interface GiphyItem {
  id?: string;
  title?: string;
  images?: { original?: GiphyImage; fixed_width?: GiphyImage };
}

function parseGiphy(body: unknown): GifResult[] {
  const data = (body as { data?: GiphyItem[] } | null)?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  const out: GifResult[] = [];
  for (const item of data) {
    const original = item.images?.original;
    const preview = item.images?.fixed_width ?? original;
    if (!item.id || !original?.url || !preview?.url) {
      continue;
    }
    out.push({
      id: item.id,
      description: item.title ?? '',
      previewUrl: preview.url,
      previewWidth: toInt(preview.width),
      previewHeight: toInt(preview.height),
      url: original.url,
      width: toInt(original.width),
      height: toInt(original.height),
    });
  }
  return out;
}

/** Giphy reports dimensions as numeric strings; coerce to a safe integer. */
function toInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}
