import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  DevicePreferenceStorageService,
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
} from '@trinity/platform-native';
import {
  isGifProviderId,
  retiredGifProvider,
  type GifConfig,
  type GifProviderId,
} from './gif.model';

const CONFIG_KEY = 'trinity.gif.config';
/** The provider a fresh install offers, before any key is set. */
export const DEFAULT_GIF_PROVIDER: GifProviderId = 'klipy';

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
  private readonly storage = inject(DevicePreferenceStorageService);

  private readonly _provider = signal<GifProviderId>(DEFAULT_GIF_PROVIDER);
  /** The active GIF provider (defaults to KLIPY even before a key is set). */
  readonly provider = this._provider.asReadonly();

  private readonly _apiKey = signal('');
  /** The API key for {@link provider}, or '' when unset. */
  readonly apiKey = this._apiKey.asReadonly();

  /** True once a non-empty API key is set — gates the GIF picker. */
  readonly configured = computed(() => this._apiKey().trim().length > 0);

  private readonly _migratedFrom = signal<string | null>(null);
  /**
   * The retired provider this device was moved off at startup, or null. Set once, on the
   * boot that migrates; the settings page reads it to explain why the key box is empty.
   */
  readonly migratedFrom = this._migratedFrom.asReadonly();

  /** Read the saved config. Wired as an app initializer at startup. */
  async init(): Promise<PreferenceInitializationOutcome> {
    let value: string | null;
    try {
      value = await firstValueFrom(this.storage.get(CONFIG_KEY));
    } catch {
      return preferenceInitializationDefaulted('storage-unavailable');
    }
    if (!value) return preferenceInitializationReady;
    let parsed: Partial<GifConfig>;
    try {
      parsed = JSON.parse(value) as Partial<GifConfig>;
    } catch {
      return preferenceInitializationDefaulted('invalid-stored-value');
    }
    try {
      const replacement = retiredGifProvider(parsed.provider);
      if (replacement) {
        // A retired provider keeps NEITHER its id nor its key. Reading the two fields
        // independently — as the branches below do — would leave the dead provider's key
        // attached to its replacement, and `configured` only asks whether a key is
        // non-empty: the picker would open against KLIPY holding a Tenor key and fail
        // every search, which reads as a broken new provider rather than a migration.
        this._migratedFrom.set(String(parsed.provider));
        this.save(replacement, '');
        return preferenceInitializationDefaulted('invalid-stored-value');
      }
      if (isGifProviderId(parsed.provider)) {
        this._provider.set(parsed.provider);
      }
      if (typeof parsed.apiKey === 'string') {
        this._apiKey.set(parsed.apiKey);
      }
      return isGifProviderId(parsed.provider) &&
        typeof parsed.apiKey === 'string'
        ? preferenceInitializationReady
        : preferenceInitializationDefaulted('invalid-stored-value');
    } catch {
      return preferenceInitializationDefaulted('invalid-stored-value');
    }
  }

  /** Set + persist the provider and its API key (the key is trimmed). */
  save(provider: GifProviderId, apiKey: string): void {
    const key = apiKey.trim();
    this._provider.set(provider);
    this._apiKey.set(key);
    void firstValueFrom(
      this.storage.set(
        CONFIG_KEY,
        JSON.stringify({ provider, apiKey: key } satisfies GifConfig),
      ),
    ).catch(() => undefined);
  }

  /** Clear the API key (disabling the picker); leaves the provider choice intact. */
  clear(): void {
    this._apiKey.set('');
    // Rewrite the blob with an empty key rather than removing it: provider and
    // apiKey share one stored value, so a remove() would drop the provider too
    // and the next boot would silently fall back to DEFAULT_GIF_PROVIDER.
    void firstValueFrom(
      this.storage.set(
        CONFIG_KEY,
        JSON.stringify({
          provider: this._provider(),
          apiKey: '',
        } satisfies GifConfig),
      ),
    ).catch(() => undefined);
  }
}
