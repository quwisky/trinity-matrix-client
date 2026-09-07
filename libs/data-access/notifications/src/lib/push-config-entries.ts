import { inject, type EnvironmentProviders } from '@angular/core';
import {
  describeConfigValue,
  isConfigRecord,
  provideConfigEntries,
  type ConfigEntry,
  type ConfigValue,
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

/** Device gateway choice; the applied pusher ledger is never exported. */
export function providePushConfigEntries(): EnvironmentProviders {
  return provideConfigEntries(() => {
    const push = inject(PushGatewayService);
    const pushers = inject(PushService);
    return [
      {
        path: 'push.gateway',
        key: 'trinity.push.gateway',
        description:
          'The push gateway URL, { disabled: true } to turn push off, or null to use the build default.',
        type: ['object', 'null'],
        read: (): ConfigValue => {
          if (push.disabled()) return { disabled: true };
          const override = push.override();
          return override
            ? {
                gatewayUrl: override.gatewayUrl,
              }
            : null;
        },
        // Persist the new choice before applying it to live pushers. This leaves the
        // runtime able to retry with the same effective gateway after a cleanup failure.
        reset: async () => {
          await push.resetToDefault();
          await applyRegistration(push, pushers);
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
            await push.resetToDefault();
            return;
          }
          if (!isConfigRecord(value)) {
            return;
          }
          if (value['disabled'] === true) {
            await push.clear();
            await firstValueFrom(pushers.unregister());
            return;
          }
          const url = value['gatewayUrl'];
          if (typeof url !== 'string') {
            return;
          }
          await push.save(url);
          await firstValueFrom(pushers.register());
        },
      },
    ] satisfies readonly ConfigEntry[];
  });
}

async function applyRegistration(
  push: PushGatewayService,
  pushers: PushService,
): Promise<void> {
  await firstValueFrom(
    push.configured() ? pushers.register() : pushers.unregister(),
  );
}

function validateGateway(value: unknown, supported: boolean): ConfigValidation {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (!isConfigRecord(value)) {
    return {
      ok: false,
      problem: `${describeConfigValue(value)} is not a push gateway (expected null, or an object with a gatewayUrl)`,
    };
  }

  if (value['disabled'] === true)
    return { ok: true, value: { disabled: true } };
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
  const normalized = { gatewayUrl: check.url };
  return notes.length > 0
    ? { ok: true, value: normalized, warning: notes.join('; ') }
    : { ok: true, value: normalized };
}
