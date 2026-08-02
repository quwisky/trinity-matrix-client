import { InjectionToken } from '@angular/core';

/**
 * Push gateway configuration.
 *
 * Its own module rather than living beside `PushService`, so that `PushGatewayService`
 * (which resolves this) and `PushService` (which consumes the result) can both depend
 * on it without importing each other. Anything shared by those two belongs here.
 */

/**
 * The gateway a pusher points at. Supplied at build time via `environment.push` and/or
 * by the user in settings; null anywhere means push is disabled.
 */
export interface PushConfig {
  /** The gateway's notify endpoint, e.g. `https://push.example/_matrix/push/v1/notify`. */
  gatewayUrl: string;
  /**
   * Base app id the gateway keys its credentials by. Optional: omit it and
   * {@link DEFAULT_APP_ID} — the app's own bundle id — is used, which is what a gateway
   * following the setup in docs/reference/push-notifications.md expects. Only set it for a gateway that
   * registered this app under some other key.
   */
  appId?: string;
}

/**
 * Fallback base app id: the application identifier itself, kept in step with
 * `capacitor.config.ts`, `android/app/build.gradle` (`applicationId`) and the Xcode
 * `PRODUCT_BUNDLE_IDENTIFIER` — all three are `eu.qwky.trinity`. APNs binds its auth key
 * to the bundle id and FCM to the sender project, so a gateway that can physically
 * deliver to this build is almost always keyed by this id.
 */
export const DEFAULT_APP_ID = 'eu.qwky.trinity';

/** Build-time default gateway (`environment.push`); null disables push. */
export const PUSH_CONFIG = new InjectionToken<PushConfig | null>('PUSH_CONFIG');
