// Probes the stacks QR sign-in (MSC4108) runs on. It starts Docker, so it runs only when
// asked: TRINITY_E2E_QR_PROBE=1 pnpm exec vitest run --config e2e/support/vitest.config.mts
// homeserver/qr-sign-in-capability. Each kind starts and stops its own stack.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquireHomeserverLease, releaseHomeserverLease } from './lease.mts';
import { start, type HomeserverHarness } from './start.mjs';
import { stop } from './stop.mjs';

const DEVICE_CODE = 'urn:ietf:params:oauth:grant-type:device_code';
const STACKS = [
  {
    kind: 'mas',
    env: { TRINITY_E2E_MAS: '1' },
    hs: (harness: HomeserverHarness) => harness.mas?.hs,
  },
  {
    kind: 'tuwunel-oauth',
    env: { TRINITY_E2E_HOMESERVER: 'tuwunel-oauth' },
    hs: (harness: HomeserverHarness) => harness.hs,
  },
];

describe.runIf(process.env['TRINITY_E2E_QR_PROBE'] === '1').each(STACKS)(
  'QR sign-in on $kind',
  { timeout: 300_000 },
  ({ env, hs: pick }) => {
    let lease: Awaited<ReturnType<typeof acquireHomeserverLease>> | undefined;
    let hs = '';

    beforeAll(async () => {
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      lease = await acquireHomeserverLease();
      hs = pick(await start()) ?? '';
    }, 600_000);

    afterAll(async () => {
      try {
        // Without the lease the running stack is someone else's.
        if (lease) await stop();
      } finally {
        releaseHomeserverLease(lease);
        vi.unstubAllEnvs();
      }
    }, 120_000);

    it('advertises MSC4108', async () => {
      const versions = await (
        await fetch(`${hs}/_matrix/client/versions`)
      ).json();
      expect(versions.unstable_features?.['org.matrix.msc4108']).toBe(true);
    });

    it('offers the device authorization grant', async () => {
      const metadata = await (
        await fetch(`${hs}/_matrix/client/v1/auth_metadata`)
      ).json();
      expect(metadata.grant_types_supported).toContain(DEVICE_CODE);
    });

    it('registers a device-code client and starts a device authorization', async () => {
      const metadata = await (
        await fetch(`${hs}/_matrix/client/v1/auth_metadata`)
      ).json();
      // The grant set matrix-js-sdk registers. Tuwunel requires authorization_code, and
      // refuses an http redirect even on loopback, hence the https one.
      const registration = await fetch(metadata.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Trinity QR probe',
          client_uri: 'https://trinity.trinityproject.dev',
          application_type: 'web',
          token_endpoint_auth_method: 'none',
          response_types: ['code'],
          redirect_uris: ['https://trinity.trinityproject.dev/sso-callback'],
          grant_types: ['authorization_code', 'refresh_token', DEVICE_CODE],
        }),
      });
      const client = await registration.json();
      expect(registration.status, JSON.stringify(client)).toBe(201);
      expect(client.client_id).toBeTruthy();

      const authorization = await fetch(
        metadata.device_authorization_endpoint,
        {
          method: 'POST',
          body: new URLSearchParams({
            client_id: client.client_id,
            scope:
              'openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:QRPROBE',
          }),
        },
      );
      const grant = await authorization.json();
      expect(authorization.ok, JSON.stringify(grant)).toBe(true);
      expect(grant.device_code).toBeTruthy();
      expect(grant.user_code).toBeTruthy();
    });

    it('creates a rendezvous session', async () => {
      const res = await fetch(
        `${hs}/_matrix/client/unstable/org.matrix.msc4108/rendezvous`,
        {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'probe',
        },
      );
      expect(res.status).toBe(201);
      expect(res.headers.get('etag')).toBeTruthy();
    });
  },
);
