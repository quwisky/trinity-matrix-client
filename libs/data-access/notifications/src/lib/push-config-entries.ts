import { inject, type EnvironmentProviders } from '@angular/core';
import {
  provideConfigEntries,
  type ConfigEntry,
} from '@trinity/platform-native';
import { PushGatewayService } from './push-gateway.service';

/**
 * The user's push-gateway override, for the config export.
 *
 * One entry rather than two, mirroring how it is stored and cleared: `appId` is meaningless
 * without a URL, and {@link PushGatewayService.clear} drops both together. `null` means no
 * override — push falls back to the build-time default.
 *
 * The applied-app-id ledger beside it is NOT exported; see `CONFIG_KEY_LEDGER` for why
 * importing one would strand a live pusher on the old gateway.
 */
export function providePushConfigEntries(): EnvironmentProviders {
  return provideConfigEntries(() => {
    const push = inject(PushGatewayService);
    return [
      {
        path: 'push.gateway',
        key: 'trinity.push.gateway',
        read: () => {
          const override = push.override();
          return override
            ? {
                gatewayUrl: override.gatewayUrl,
                appId: override.appId ?? null,
              }
            : null;
        },
        reset: () => push.clear(),
      },
    ] satisfies readonly ConfigEntry[];
  });
}
