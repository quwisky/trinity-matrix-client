import { inject, type EnvironmentProviders } from '@angular/core';
import {
  provideConfigEntries,
  type ConfigEntry,
} from '@trinity/platform-native';
import { firstValueFrom } from 'rxjs';
import { PushGatewayService } from './push-gateway.service';
import { PushService } from './push.service';

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
    const pushers = inject(PushService);
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
        /**
         * Pushers first, then the stored gateway — the same order
         * `push-gateway-block.component.ts` uses for its Clear button, and for the same
         * reason: {@link PushService.unregister} reads the applied-app-id ledger to know
         * which pushers to remove, and the ledger is only meaningful while the gateway it
         * was applied for is still configured.
         *
         * A bare `clear()` would leave the homeserver delivering room and event metadata to
         * a gateway the user just disowned, and it cannot self-heal: with no override and no
         * build-time `PUSH_CONFIG`, `canPush()` is false and `register()` early-returns
         * forever, so nothing ever removes them. A no-op on web and desktop, where there are
         * no pushers to remove.
         */
        reset: async () => {
          // unregister() already swallows every removePusher rejection, so this cannot
          // reject the Promise.all that resetToDefaults runs the entries under.
          await firstValueFrom(pushers.unregister());
          await push.clear();
        },
      },
    ] satisfies readonly ConfigEntry[];
  });
}
