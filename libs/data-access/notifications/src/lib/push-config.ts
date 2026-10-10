import { InjectionToken } from '@angular/core';

/**
 * Push gateway configuration, supplied at build time through `environment.push`.
 * `PushService` reads it through {@link PUSH_CONFIG}; there is no device override.
 */

/** The gateway a pusher points at. Null anywhere means push is disabled. */
export interface PushConfig {
  /** The gateway's notify endpoint, e.g. `https://push.example/_matrix/push/v1/notify`. */
  gatewayUrl: string;
  /**
   * Base app id the gateway keys its credentials by. Optional: omit it and
   * {@link DEFAULT_APP_ID} — the app's own bundle id — is used, which is what a gateway
   * following docs-internal/maintenance/push-notifications.md expects. Only set it for a gateway that
   * registered this app under some other key.
   */
  appId?: string;
}

/**
 * Fallback base app id: the application identifier itself, kept in step with
 * `capacitor.config.ts`, `android/app/build.gradle` (`applicationId`) and the Xcode
 * `PRODUCT_BUNDLE_IDENTIFIER` — all three are `dev.trinityproject.trinity`. APNs binds its auth key
 * to the bundle id and FCM to the sender project, so a gateway that can physically
 * deliver to this build is almost always keyed by this id.
 */
export const DEFAULT_APP_ID = 'dev.trinityproject.trinity';

/** The build's gateway (`environment.push`); null disables push. */
export const PUSH_CONFIG = new InjectionToken<PushConfig | null>('PUSH_CONFIG');
