import { Injectable, computed, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  isGifProviderId,
  type GifConfig,
  type GifProviderId,
} from './gif.model';

const CONFIG_KEY = 'trinity.gif.config';
const DEFAULT_PROVIDER: GifProviderId = 'tenor';

/**
 * Persists the user's GIF-picker configuration (provider + API key). Like the
 * theme and feature flags, this is non-secret UI config, so it lives in Capacitor
 * `Preferences` (localStorage on web, native KV on device) rather than secure
 * storage — the third-party key is not an account credential. Exposed as signals
 * so the composer can gate its GIF affordance on {@link configured} and the
 * settings form can bind the current values.
 */
@Injectable({ providedIn: 'root' })
export class GifSettingsService {
  private readonly _provider = signal<GifProviderId>(DEFAULT_PROVIDER);
  /** The active GIF provider (defaults to Tenor even before a key is set). */
  readonly provider = this._provider.asReadonly();

  private readonly _apiKey = signal('');
  /** The API key for {@link provider}, or '' when unset. */
  readonly apiKey = this._apiKey.asReadonly();

  /** True once a non-empty API key is set — gates the GIF picker. */
  readonly configured = computed(() => this._apiKey().trim().length > 0);

  /** Read the saved config. Wired as an app initializer at startup. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: CONFIG_KEY });
      const parsed = value ? (JSON.parse(value) as Partial<GifConfig>) : null;
      if (parsed && isGifProviderId(parsed.provider)) {
        this._provider.set(parsed.provider);
      }
      if (parsed && typeof parsed.apiKey === 'string') {
        this._apiKey.set(parsed.apiKey);
      }
    } catch {
      // No stored config (or storage/parse failure) → keep the defaults (unset).
    }
  }

  /** Set + persist the provider and its API key (the key is trimmed). */
  save(provider: GifProviderId, apiKey: string): void {
    const key = apiKey.trim();
    this._provider.set(provider);
    this._apiKey.set(key);
    void Preferences.set({
      key: CONFIG_KEY,
      value: JSON.stringify({ provider, apiKey: key } satisfies GifConfig),
    }).catch(() => undefined);
  }

  /** Clear the API key (disabling the picker); leaves the provider choice intact. */
  clear(): void {
    this._apiKey.set('');
    // Rewrite the blob with an empty key rather than removing it: provider and
    // apiKey share one stored value, so a remove() would drop the provider too
    // and the next boot would silently fall back to DEFAULT_PROVIDER.
    void Preferences.set({
      key: CONFIG_KEY,
      value: JSON.stringify({
        provider: this._provider(),
        apiKey: '',
      } satisfies GifConfig),
    }).catch(() => undefined);
  }
}
