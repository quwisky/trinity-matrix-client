import { Injectable, computed, inject, signal } from '@angular/core';
import { defer, firstValueFrom, map, Observable } from 'rxjs';
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
import {
  isTrinityPushRegistrationState,
  type TrinityPushRegistrationState,
} from '@trinity/util/push-client';

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
const LEGACY_APP_IDS_KEY = 'trinity.push.legacy-app-ids';
const REGISTRATION_KEY_PREFIX = 'trinity.push.registration.';

/**
 * The user's stored gateway override.
 *
 * The applied-id ledger ({@link APPLIED_KEY}) is retained for cleaning up pushers
 * created by older client versions that used configurable app IDs.
 */
interface StoredGateway {
  readonly gatewayUrl: string;
  readonly appId?: string;
  readonly disabled?: boolean;
}

interface StoredGatewayLoad {
  readonly legacyAppIds?: readonly string[];
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
  private readonly _configurationUnavailable = signal(false);
  private _legacyOwnershipReady = true;
  readonly disabled = this._disabled.asReadonly();
  /** The user's stored override, or null when the build-time default applies. */
  readonly override = this._override.asReadonly();

  /**
   * The config push should actually use: the user's override, else the build-time
   * default, unless the user explicitly cleared it (the disabled marker).
   */
  readonly effective = computed<PushConfig | null>(() => {
    if (this._configurationUnavailable()) return null;
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
  private readonly _legacyAppIds = signal<readonly string[]>([]);
  readonly legacyAppIds = this._legacyAppIds.asReadonly();
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
    const legacy = await this.loadLegacyAppIds(override.legacyAppIds ?? []);
    const ledger = await this.loadAppliedAppId(override.legacyApplied);
    if (
      override.outcome.kind !== 'ready' ||
      legacy.kind !== 'ready' ||
      ledger.kind !== 'ready'
    ) {
      this._configurationUnavailable.set(true);
    } else {
      this._configurationUnavailable.set(false);
    }
    return combinePreferenceInitialization([override.outcome, legacy, ledger]);
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
      this._configurationUnavailable.set(true);
      return {
        outcome: preferenceInitializationDefaulted('storage-unavailable'),
      };
    }
    if (!value) {
      this._configurationUnavailable.set(false);
      return { outcome: preferenceInitializationReady };
    }
    let stored: Partial<StoredGateway> & { appliedAppId?: unknown };
    try {
      stored = JSON.parse(value) as Partial<StoredGateway> & {
        appliedAppId?: unknown;
      };
    } catch {
      this._configurationUnavailable.set(true);
      return {
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    }
    if (
      typeof stored !== 'object' ||
      stored === null ||
      Array.isArray(stored)
    ) {
      this._configurationUnavailable.set(true);
      return {
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    }
    if (stored.disabled === true) {
      this._configurationUnavailable.set(false);
      this._disabled.set(true);
      return {
        legacyAppIds: legacyIds(stored),
        outcome: preferenceInitializationReady,
      };
    }
    if (typeof stored.gatewayUrl !== 'string') {
      this._configurationUnavailable.set(true);
      return {
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    }
    const storedLegacyAppIds = legacyIds(stored);
    const legacyApplied =
      typeof stored.appliedAppId === 'string' && stored.appliedAppId
        ? stored.appliedAppId
        : undefined;
    // Re-validate on load: the blob could be hand-edited, or written by a build whose
    // rules differed. Normalising is idempotent, so a good value survives untouched.
    const check = normalizeGatewayUrl(stored.gatewayUrl);
    if (!check.ok) {
      this._configurationUnavailable.set(true);
      return {
        legacyAppIds: storedLegacyAppIds,
        legacyApplied,
        outcome: preferenceInitializationDefaulted('invalid-stored-value'),
      };
    }
    this._override.set({
      gatewayUrl: check.url,
      ...(typeof stored.appId === 'string' && stored.appId
        ? { appId: stored.appId }
        : {}),
    });
    this._configurationUnavailable.set(false);
    return {
      legacyAppIds: storedLegacyAppIds,
      legacyApplied,
      outcome: preferenceInitializationReady,
    };
  }

  private async loadLegacyAppIds(
    candidates: readonly string[],
  ): Promise<PreferenceInitializationOutcome> {
    let value: string | null;
    try {
      value = await firstValueFrom(this.storage.get(LEGACY_APP_IDS_KEY));
    } catch {
      this._legacyOwnershipReady = false;
      this._legacyAppIds.set(uniqueAppIds(candidates));
      return preferenceInitializationDefaulted('storage-unavailable');
    }
    if (value === null) {
      const ids = uniqueAppIds(candidates);
      this._legacyAppIds.set(ids);
      if (ids.length === 0) return preferenceInitializationReady;
      try {
        await firstValueFrom(
          this.storage.set(LEGACY_APP_IDS_KEY, JSON.stringify(ids)),
        );
      } catch {
        this._legacyOwnershipReady = false;
        return preferenceInitializationDefaulted('storage-unavailable');
      }
      this._legacyOwnershipReady = true;
      return preferenceInitializationReady;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      this._legacyOwnershipReady = false;
      this._legacyAppIds.set(uniqueAppIds(candidates));
      return preferenceInitializationDefaulted('invalid-stored-value');
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((id) => typeof id === 'string')
    ) {
      this._legacyOwnershipReady = false;
      this._legacyAppIds.set(uniqueAppIds(candidates));
      return preferenceInitializationDefaulted('invalid-stored-value');
    }
    this._legacyAppIds.set(uniqueAppIds([...parsed, ...candidates]));
    this._legacyOwnershipReady = true;
    return preferenceInitializationReady;
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
      this.addLegacyAppId(value);
      return preferenceInitializationReady;
    }
    if (legacy) {
      this._appliedAppId.set(legacy);
      this.addLegacyAppId(legacy);
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
    this.ensureMutationReady();
    const next: StoredGateway = { gatewayUrl: url };
    await this.persistLegacyAppIds();
    await this.persist(next);
    this._disabled.set(false);
    this._override.set(next);
    this._configurationUnavailable.set(false);
  }

  /** Load one account's durable pusher identity state. */
  loadRegistration(
    accountId: string,
  ): Observable<TrinityPushRegistrationState | null> {
    return defer(() => {
      this.ensureMutationReady();
      return this.storage.get(this.registrationKey(accountId));
    }).pipe(
      map((value) => {
        if (value === null) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw new Error('Persisted push registration state is malformed');
        }
        if (!isTrinityPushRegistrationState(parsed)) {
          throw new Error('Persisted push registration state is malformed');
        }
        return parsed;
      }),
    );
  }

  /** Persist one account's pusher identity state, or remove it after cleanup. */
  saveRegistration(
    accountId: string,
    state: TrinityPushRegistrationState | null,
  ): Observable<void> {
    return defer(() => {
      this.ensureMutationReady();
      if (state !== null && !isTrinityPushRegistrationState(state)) {
        throw new Error('Push registration state is malformed');
      }
      const key = this.registrationKey(accountId);
      return state === null
        ? this.storage.remove(key)
        : this.storage.set(key, JSON.stringify(state));
    });
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
    this.ensureMutationReady();
    await this.persistLegacyAppIds();
    await firstValueFrom(this.storage.set(APPLIED_KEY, appId));
    this._appliedAppId.set(appId);
  }

  /** Disable push on this device, retaining the applied ledger for cleanup. */
  async clear(): Promise<void> {
    this.ensureMutationReady();
    await this.persistLegacyAppIds();
    await firstValueFrom(
      this.storage.set(STORAGE_KEY, JSON.stringify({ disabled: true })),
    );
    this._override.set(null);
    this._disabled.set(true);
    this._configurationUnavailable.set(false);
  }

  /** Remove the device choice and use the build configuration again. */
  async resetToDefault(): Promise<void> {
    this.ensureMutationReady();
    await this.persistLegacyAppIds();
    await firstValueFrom(this.storage.remove(STORAGE_KEY));
    this._override.set(null);
    this._disabled.set(false);
    this._configurationUnavailable.set(false);
  }

  private async persist(value: StoredGateway): Promise<void> {
    await firstValueFrom(this.storage.set(STORAGE_KEY, JSON.stringify(value)));
  }

  private registrationKey(accountId: string): string {
    return `${REGISTRATION_KEY_PREFIX}${encodeURIComponent(accountId)}`;
  }

  private addLegacyAppId(appId: string): void {
    this._legacyAppIds.update((ids) => uniqueAppIds([...ids, appId]));
  }

  private async persistLegacyAppIds(): Promise<void> {
    await firstValueFrom(
      this.storage.set(
        LEGACY_APP_IDS_KEY,
        JSON.stringify(this._legacyAppIds()),
      ),
    );
  }

  private ensureMutationReady(): void {
    if (this._configurationUnavailable() || !this._legacyOwnershipReady) {
      throw new Error(
        'Push gateway configuration is awaiting storage recovery',
      );
    }
  }
}

function uniqueAppIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim() !== ''))];
}

function legacyIds(stored: {
  readonly appId?: unknown;
  readonly appliedAppId?: unknown;
}): readonly string[] {
  return uniqueAppIds(
    [stored.appId, stored.appliedAppId].filter(
      (id): id is string => typeof id === 'string',
    ),
  );
}
