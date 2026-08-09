import { inject, type EnvironmentProviders } from '@angular/core';
import {
  describeConfigValue,
  isConfigRecord,
  provideConfigEntries,
  type ConfigEntry,
  type ConfigValidation,
} from '@trinity/platform-native';
import { firstValueFrom } from 'rxjs';
import {
  GATEWAY_NOTIFY_PATH,
  normalizeGatewayUrl,
  type GatewayUrlProblem,
} from './push-gateway-url';
import { PushGatewayService } from './push-gateway.service';
import { PushService } from './push.service';

/** Why a pasted gateway URL cannot be used, in the words the settings form would use. */
const URL_PROBLEMS: Record<GatewayUrlProblem, string> = {
  empty: 'is empty',
  'too-long': 'is too long to be a gateway URL',
  malformed: 'is not a URL',
  'unsupported-scheme': 'is not an http or https URL',
  'embedded-credentials':
    'carries a username and password, which would be stored in plain text and handed to your homeserver',
  'wrong-path': `does not end in ${GATEWAY_NOTIFY_PATH}, the only path a homeserver accepts`,
};

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
        /**
         * Checked through {@link normalizeGatewayUrl} — the same rules the settings form
         * applies and the service re-applies on load, so an imported URL cannot be one a
         * homeserver would reject with an opaque error days later, when a notification
         * fails to arrive.
         */
        validate: (value) => validateGateway(value, push.supported()),
        write: async (value) => {
          if (value === null) {
            await push.clear();
            return;
          }
          if (!isConfigRecord(value)) {
            return;
          }
          const url = value['gatewayUrl'];
          const appId = value['appId'];
          if (typeof url !== 'string') {
            return;
          }
          await push.save(url, typeof appId === 'string' ? appId : undefined);
        },
      },
    ] satisfies readonly ConfigEntry[];
  });
}

function validateGateway(value: unknown, supported: boolean): ConfigValidation {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!isConfigRecord(value)) {
    return {
      ok: false,
      problem: `${describeConfigValue(value)} is not a push gateway (expected null, or an object with a gatewayUrl and an appId)`,
    };
  }

  const url = value['gatewayUrl'];
  if (typeof url !== 'string') {
    return {
      ok: false,
      problem: `its gatewayUrl is ${describeConfigValue(url)}, not text`,
    };
  }
  const check = normalizeGatewayUrl(url);
  if (!check.ok) {
    return {
      ok: false,
      problem: `${describeConfigValue(url)} ${URL_PROBLEMS[check.problem]}`,
    };
  }

  const appId = value['appId'];
  if (appId !== null && appId !== undefined && typeof appId !== 'string') {
    return {
      ok: false,
      problem: `its appId is ${describeConfigValue(appId)}, not text`,
    };
  }
  const trimmed = typeof appId === 'string' ? appId.trim() : '';

  // Stored either way, and said out loud either way: a config written on a phone and applied
  // on the desktop keeps its gateway (so it survives the trip back) but cannot use it, and
  // an http gateway is accepted by homeservers yet sends notification metadata in the clear.
  const notes: string[] = [];
  if (!supported) {
    notes.push(
      'push notifications are only delivered on iOS and Android, so this gateway is kept but does nothing here',
    );
  }
  if (check.insecure) {
    notes.push(
      'this gateway is plain http, so your homeserver will send notification metadata to it unencrypted',
    );
  }
  const normalized = { gatewayUrl: check.url, appId: trimmed ? trimmed : null };
  return notes.length > 0
    ? { ok: true, value: normalized, warning: notes.join('; ') }
    : { ok: true, value: normalized };
}
