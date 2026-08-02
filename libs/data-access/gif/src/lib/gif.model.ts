/** A GIF search provider Trinity can talk to. */
export type GifProviderId = 'tenor' | 'giphy';

/** Persisted GIF-picker configuration: the active provider and its API key. */
export interface GifConfig {
  provider: GifProviderId;
  apiKey: string;
}

/** True when `value` is a known provider id (narrows persisted/user input). */
export function isGifProviderId(value: unknown): value is GifProviderId {
  return value === 'tenor' || value === 'giphy';
}

/**
 * A single GIF result, normalized across providers. `previewUrl` is a small,
 * autoplaying preview shown in the picker grid; `url` is the full-size GIF that
 * gets downloaded and sent as an `m.image`.
 */
export interface GifResult {
  /** Provider-native id — a stable track-by key. */
  id: string;
  /** Human description / title, used for alt text (may be empty). */
  description: string;
  /** Small looping preview for the grid. */
  previewUrl: string;
  previewWidth: number;
  previewHeight: number;
  /** Full-size GIF URL to download and send. */
  url: string;
  width: number;
  height: number;
}

/** Display + onboarding metadata for a provider (used by the picker + settings). */
export interface GifProviderMeta {
  id: GifProviderId;
  label: string;
  /** Attribution line the provider's terms require us to show. */
  attribution: string;
  /** Where a user gets a free API key. */
  apiKeyUrl: string;
}

/** The providers Trinity supports, in the order they're offered in settings. */
export const GIF_PROVIDERS: readonly GifProviderMeta[] = [
  {
    id: 'tenor',
    label: 'Tenor',
    attribution: 'Powered by Tenor',
    apiKeyUrl: 'https://developers.google.com/tenor/guides/quickstart',
  },
  {
    id: 'giphy',
    label: 'GIPHY',
    attribution: 'Powered by GIPHY',
    apiKeyUrl: 'https://developers.giphy.com/dashboard/',
  },
];
