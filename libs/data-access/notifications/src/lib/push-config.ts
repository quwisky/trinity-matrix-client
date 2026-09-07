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
}

/**
 * Legacy base app id retained in the applied-id ledger so upgrades can remove old
 * pushers. New registrations use the fixed gateway app IDs from the shared push client.
 */
export const DEFAULT_APP_ID = 'eu.qwky.trinity';

/** Build-time default gateway (`environment.push`); null disables push. */
export const PUSH_CONFIG = new InjectionToken<PushConfig | null>('PUSH_CONFIG');
