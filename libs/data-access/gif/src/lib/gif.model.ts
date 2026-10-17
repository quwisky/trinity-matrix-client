/** A GIF search provider Trinity can talk to. */
export type GifProviderId = 'klipy' | 'giphy';

/** Persisted GIF-picker configuration: the active provider and its API key. */
export interface GifConfig {
  provider: GifProviderId;
  apiKey: string;
}

/** True when `value` is a known provider id (narrows persisted/user input). */
export function isGifProviderId(value: unknown): value is GifProviderId {
  return value === 'klipy' || value === 'giphy';
}

/**
 * Provider ids Trinity used to support, and what each becomes.
 *
 * `tenor` (API shut down by Google) can still sit in `trinity.gif.config` and in exported
 * configuration documents, so the mapping is a named export. A retired id keeps its key OUT of
 * the migration: a Tenor key cannot authenticate against KLIPY. See
 * {@link GifSettingsService.init} and the `gif.provider` config entry.
 */
export const RETIRED_GIF_PROVIDERS: Readonly<Record<string, GifProviderId>> = {
  tenor: 'klipy',
};

/** The provider a retired id migrates to, or null when `value` is not a retired id. */
export function retiredGifProvider(value: unknown): GifProviderId | null {
  return typeof value === 'string'
    ? (RETIRED_GIF_PROVIDERS[value] ?? null)
    : null;
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
    id: 'klipy',
    label: 'KLIPY',
    attribution: 'Powered by KLIPY',
    apiKeyUrl: 'https://klipy.com/developers',
  },
  {
    id: 'giphy',
    label: 'GIPHY',
    attribution: 'Powered by GIPHY',
    apiKeyUrl: 'https://developers.giphy.com/dashboard/',
  },
];
