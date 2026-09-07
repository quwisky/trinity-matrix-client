import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  DevicePreferenceStorageService,
  NativePushRegistrationService,
  combinePreferenceInitialization,
  preferenceInitializationDefaulted,
  preferenceInitializationReady,
  type PreferenceInitializationOutcome,
} from '@trinity/platform-native';
import { normalizeGatewayUrl } from './push-gateway-url';
import { PUSH_CONFIG, type PushConfig } from './push-config';

const STORAGE_KEY = 'trinity.push.gateway';

/**
 * The applied-app-id ledger, in its own key rather than inside the override blob.
 *
 * It records what actually reached the homeservers, which has nothing to do with whether
 * the user set an override: a build-time `PUSH_CONFIG` registers pushers too. Held in the
 * blob it could only ever be written when an override existed, so the fallback path never
 * recorded anything and its pushers could never be cleaned up (see {@link markApplied}).
 */
const APPLIED_KEY = 'trinity.push.applied-app-id';

/**
 * The user's stored gateway override.
 *
 * The applied-id ledger ({@link APPLIED_KEY}) is retained for cleaning up pushers
 * created by older client versions that used configurable app IDs.
 */
interface StoredGateway {
  readonly gatewayUrl: string;
  readonly disabled?: boolean;
}

interface StoredGatewayLoad {
  readonly legacyApplied?: string;
  readonly outcome: PreferenceInitializationOutcome;
}

/**
 * Owns the user-configurable push gateway: persists the override, resolves it against
 * the build-time {@link PUSH_CONFIG} default, and remembers which app id the live
 * pushers were registered under.
 *
 * Device-local by design, in Capacitor `Preferences` rather than Matrix account data or
 * secure storage. Account data would sync a value that cannot travel — `app_id` is
 * per-platform and the `pushkey` is this install's device token, so an iOS gateway
 * config is meaningless to the Android install on the same account. Secure storage
 * would buy nothing: the URL is published to the homeserver as `pusher.data.url` and
 * any client can read it back from `GET /pushers`, so the UI must not imply otherwise.
 *
 * Follows `GifSettingsService`'s shape — signals, an `init()` wired as an app
 * initializer, fire-and-forget persistence — so the two user-config services read alike.
 */
@Injectable({ providedIn: 'root' })
export class PushGatewayService {
  /** Build-time default (`environment.push`), with the shipped dummy URL. */
  private readonly fallback = inject(PUSH_CONFIG, { optional: true });
  private readonly storage = inject(DevicePreferenceStorageService);
  private readonly nativePush = inject(NativePushRegistrationService);

  private readonly _override = signal<StoredGateway | null>(null);
  private readonly _disabled = signal(false);
  readonly disabled = this._disabled.asReadonly();
  /** The user's stored override, or null when the build-time default applies. */
  readonly override = this._override.asReadonly();

  /**
   * The config push should actually use: the user's override, else the build-time
   * default, unless the user explicitly cleared it (the disabled marker).
   */
  readonly effective = computed<PushConfig | null>(() => {
    const stored = this._override();
    if (this._disabled()) return null;
    if (stored) {
      return { gatewayUrl: stored.gatewayUrl };
    }
    return this.fallback;
  });

  /** True when some gateway is configured, from either source. */
  readonly configured = computed(() => this.effective() !== null);

  private readonly _appliedAppId = signal<string | null>(null);
  /**
   * The exact app id (or a legacy base id) the live pushers were registered under, or null if none have
   * been written. Read by the push service to remove the stale pusher when the app id
   * changes; null means there is nothing to clean up.
   */
  readonly appliedAppId = this._appliedAppId.asReadonly();

  /**
   * Whether push can work on this device at all. Mirrors the platform half of
   * `PushService.canPush()`: web and the Electron shell (whose platform is also `web`)
   * have no push plugin, so the settings UI shows the block disabled there rather than
   * letting someone type a URL that can never take effect.
   */
  readonly supported = computed(() => this.nativePush.supported());

  /** Read the saved override + the applied-id ledger. Wired as an app initializer. */
  async init(): Promise<PreferenceInitializationOutcome> {
    const override = await this.loadOverride();
    const ledger = await this.loadAppliedAppId(override.legacyApplied);
    return combinePreferenceInitialization([override.outcome, ledger]);
  }

  /**
   * Load the stored override.
   *
   * @returns the ledger value from the legacy in-blob field, if this install predates
   * {@link APPLIED_KEY} — the caller migrates it.
   */
  private async loadOverride(): Promise<StoredGatewayLoad> {
    let value: string | null;
    try {
      value = await firstValueFrom(this.storage.get(STORAGE_KEY));
    } catch {
      return {
        outcome: preferenceInitializationDefaulted('storage-unavailable'),
      };
    }
    if (!value) return { outcome: preferenceInitializationReady };
    let stored: Partial<StoredGateway> & { appliedAppId?: unknown };
    try {
      stored = JSON.parse(value) as Partial<StoredGateway> & {
        appliedAppId?: unknown;
      };
    } catch {
      return {
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    }
    if (
      typeof stored !== 'object' ||
      stored === null ||
      Array.isArray(stored)
    ) {
      return {
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    }
    if (stored.disabled === true) {
      this._disabled.set(true);
      return { outcome: preferenceInitializationReady };
    }
    if (typeof stored.gatewayUrl !== 'string') {
      return {
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    }
    const legacyApplied =
      typeof stored.appliedAppId === 'string' ? stored.appliedAppId : undefined;
    // Re-validate on load: the blob could be hand-edited, or written by a build whose
    // rules differed. Normalising is idempotent, so a good value survives untouched.
    const check = normalizeGatewayUrl(stored.gatewayUrl);
    if (!check.ok) {
      return {
        legacyApplied,
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    }
    this._override.set({ gatewayUrl: check.url });
    return { legacyApplied, outcome: preferenceInitializationReady };
  }

  private async loadAppliedAppId(
    legacy: string | undefined,
  ): Promise<PreferenceInitializationOutcome> {
    let value: string | null;
    try {
      value = await firstValueFrom(this.storage.get(APPLIED_KEY));
    } catch {
      return preferenceInitializationDefaulted('storage-unavailable');
    }
    if (typeof value === 'string' && value) {
      this._appliedAppId.set(value);
      return preferenceInitializationReady;
    }
    if (legacy) {
      this._appliedAppId.set(legacy);
      try {
        await firstValueFrom(this.storage.set(APPLIED_KEY, legacy));
      } catch {
        return preferenceInitializationDefaulted('storage-unavailable');
      }
    }
    return value === ''
      ? preferenceInitializationDefaulted('invalid-stored-value')
      : preferenceInitializationReady;
  }

  /**
   * Set + persist the override. `url` must already be normalised (see
   * {@link normalizeGatewayUrl}). Fixed app IDs come from the shared push client.
   *
   * Deliberately leaves the applied-id ledger alone: it describes the pushers currently
   * live on the homeservers, which this call has not touched yet. The push service
   * updates it via {@link markApplied} once the new pushers are actually written.
   */
  async save(url: string): Promise<void> {
    const next: StoredGateway = { gatewayUrl: url };
    this._disabled.set(false);
    this._override.set(next);
    await this.persist(next);
  }

  /**
   * Record which app id the live pushers now carry, so a later change knows what
   * to remove. Called by the push service after a successful registration round.
   *
   * Independent of whether an override exists: pushers registered from the build-time
   * default are just as real, and while this was stored inside the override blob they
   * were never recorded — so changing the app id afterwards left the first pusher
   * forwarding room/event metadata to the previous gateway operator indefinitely.
   */
  async markApplied(appId: string): Promise<void> {
    if (this._appliedAppId() === appId) {
      return;
    }
    this._appliedAppId.set(appId);
    await firstValueFrom(this.storage.set(APPLIED_KEY, appId)).catch(
      () => undefined,
    );
  }

  /** Disable push on this device, retaining the applied ledger for cleanup. */
  async clear(): Promise<void> {
    this._override.set(null);
    this._disabled.set(true);
    await firstValueFrom(
      this.storage.set(STORAGE_KEY, JSON.stringify({ disabled: true })),
    ).catch(() => undefined);
  }

  /** Remove the device choice and use the build configuration again. */
  async resetToDefault(): Promise<void> {
    this._override.set(null);
    this._disabled.set(false);
    await firstValueFrom(this.storage.remove(STORAGE_KEY)).catch(
      () => undefined,
    );
  }

  private async persist(value: StoredGateway): Promise<void> {
    await firstValueFrom(
      this.storage.set(STORAGE_KEY, JSON.stringify(value)),
    ).catch(() => undefined);
  }
}
