import { Injectable, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { normalizeGatewayUrl } from './push-gateway-url';
import { PUSH_CONFIG, type PushConfig } from './push-config';

const STORAGE_KEY = 'trinity.push.gateway';

/**
 * The user's stored gateway override, plus a record of what was last written to the
 * homeservers.
 *
 * `appId` is what the user *wants*; `appliedAppId` is what actually reached the
 * homeservers. They are separate fields on purpose. A pusher's identity is
 * `(user_id, app_id, pushkey)`, so changing the app id does not update the old pusher —
 * it creates a second one and leaves the first delivering to the old gateway
 * indefinitely (confirmed against Synapse: after an app-id change `GET /pushers`
 * returns two rows). Removing the stale one requires knowing the id it was registered
 * under, which is gone the instant `appId` is overwritten — hence the ledger, persisted
 * so it also survives the app being killed between the remove and the set.
 */
interface StoredGateway {
  readonly gatewayUrl: string;
  readonly appId?: string;
  readonly appliedAppId?: string;
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
  /** Build-time default (`environment.push`); null in a stock build. */
  private readonly fallback = inject(PUSH_CONFIG, { optional: true });

  private readonly _override = signal<StoredGateway | null>(null);
  /** The user's stored override, or null when the build-time default applies. */
  readonly override = this._override.asReadonly();

  /**
   * The config push should actually use: the user's override, else the build-time
   * default, else null (push disabled). `appId` is left undefined when the user did not
   * set one, and `DEFAULT_APP_ID` is substituted at the point of use
   * (`PushService.appId()`) rather than here, so the stored shape stays a faithful
   * record of what the user actually chose.
   */
  readonly effective = computed<PushConfig | null>(() => {
    const stored = this._override();
    if (stored) {
      return { gatewayUrl: stored.gatewayUrl, appId: stored.appId };
    }
    return this.fallback;
  });

  /** True when some gateway is configured, from either source. */
  readonly configured = computed(() => this.effective() !== null);

  /**
   * The base app id the live pushers were last registered under, or null if none have
   * been written. Read by the push service to remove the stale pusher when the app id
   * changes; null means there is nothing to clean up.
   */
  readonly appliedAppId = computed(
    () => this._override()?.appliedAppId ?? null,
  );

  /**
   * Whether push can work on this device at all. Mirrors the platform half of
   * `PushService.canPush()`: web and the Electron shell (whose platform is also `web`)
   * have no push plugin, so the settings UI shows the block disabled there rather than
   * letting someone type a URL that can never take effect.
   */
  readonly supported = computed(() => {
    const platform = Capacitor.getPlatform();
    return platform === 'ios' || platform === 'android';
  });

  /** Read the saved override. Wired as an app initializer at startup. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: STORAGE_KEY });
      const stored = value
        ? (JSON.parse(value) as Partial<StoredGateway>)
        : null;
      if (!stored || typeof stored.gatewayUrl !== 'string') {
        return;
      }
      // Re-validate on load: the blob could be hand-edited, or written by a build whose
      // rules differed. Normalising is idempotent, so a good value survives untouched.
      const check = normalizeGatewayUrl(stored.gatewayUrl);
      if (!check.ok) {
        return;
      }
      this._override.set({
        gatewayUrl: check.url,
        appId: typeof stored.appId === 'string' ? stored.appId : undefined,
        appliedAppId:
          typeof stored.appliedAppId === 'string'
            ? stored.appliedAppId
            : undefined,
      });
    } catch {
      // No stored override, or storage/parse failure → the build-time default applies.
    }
  }

  /**
   * Set + persist the override. `url` must already be normalised (see
   * {@link normalizeGatewayUrl}); an empty `appId` is stored as absent rather than as
   * `''`, so the default applies rather than an app id of `".ios"`.
   *
   * Deliberately leaves `appliedAppId` alone: it describes the pushers currently live
   * on the homeservers, which this call has not touched yet. The push service updates
   * it via {@link markApplied} once the new pushers are actually written.
   */
  async save(url: string, appId?: string): Promise<void> {
    const trimmed = appId?.trim();
    const next: StoredGateway = {
      gatewayUrl: url,
      appId: trimmed ? trimmed : undefined,
      appliedAppId: this._override()?.appliedAppId,
    };
    this._override.set(next);
    await this.persist(next);
  }

  /**
   * Record which base app id the live pushers now carry, so a later change knows what
   * to remove. Called by the push service after a successful registration round.
   */
  async markApplied(appId: string): Promise<void> {
    const current = this._override();
    if (!current || current.appliedAppId === appId) {
      return;
    }
    const next: StoredGateway = { ...current, appliedAppId: appId };
    this._override.set(next);
    await this.persist(next);
  }

  /**
   * Drop the override so the build-time default (usually none) applies again.
   *
   * Removes the whole key rather than blanking the URL: unlike the GIF config, where
   * provider and key share a blob and a `remove()` would lose the provider too, every
   * field here is meaningless without a URL — including `appliedAppId`, whose pushers
   * the caller is expected to have torn down first.
   */
  async clear(): Promise<void> {
    this._override.set(null);
    await Preferences.remove({ key: STORAGE_KEY }).catch(() => undefined);
  }

  private async persist(value: StoredGateway): Promise<void> {
    await Preferences.set({
      key: STORAGE_KEY,
      value: JSON.stringify(value),
    }).catch(() => undefined);
  }
}
