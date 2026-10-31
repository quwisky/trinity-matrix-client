import { firstValueFrom, type Subscription, tap } from 'rxjs';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  ServerLogoutHoldUpdate,
  SessionEngine,
} from '@trinity/data-access/matrix-client';
import {
  type StdioTransport,
  startTesthostAccount,
  testhostBinaryAvailable,
} from '@trinity/testing';
import { proxyEngine } from '@trinity/util/matrix';
import { defineContactAddressesEngineContract } from '../../contract/contact-addresses-engine.contract';
import { contactAddressesSynapseFixture } from '../../contract/contact-addresses-synapse-fixture';
import type { ContactAddressesEngine } from '../contact-addresses-engine';

// Runs the engine contract against the Rust test host and a live Synapse; skipped unless
// TRINITY_ENGINE_CONTRACT_HS and TRINITY_ENGINE_TESTHOST are set. The mail cases need the
// harness's Mailpit, the identity cases Sydent too.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const identityUrl = process.env['TRINITY_ENGINE_CONTRACT_IDENTITY'];
const mailpit = process.env['TRINITY_ENGINE_CONTRACT_MAILPIT'];

const fixtureEnv = () => ({
  baseUrl: baseUrl as string,
  serverName,
  secret,
  mailpit,
  identityUrl,
});

describe.skipIf(!baseUrl || !testhostBinaryAvailable())(
  'Rust ContactAddressesEngine against Synapse',
  () => {
    let transport: StdioTransport | undefined;
    afterAll(async () => {
      await transport?.dispose();
    });

    defineContactAddressesEngineContract(
      async () => {
        const { me, ...fixture } =
          await contactAddressesSynapseFixture(fixtureEnv());
        transport = await startTesthostAccount(baseUrl as string, me);
        return {
          engine: proxyEngine<ContactAddressesEngine>(
            'contactAddresses',
            transport,
          ),
          accountId: me.userId,
          ...fixture,
        };
      },
      {
        identity: Boolean(identityUrl && mailpit),
        mail: Boolean(mailpit),
        testTimeoutMs: 30_000,
      },
    );

    it('reports a dead token to a hold before threePids answers', async () => {
      const { me } = await contactAddressesSynapseFixture({
        baseUrl: baseUrl as string,
        serverName,
        secret,
      });
      const host = await startTesthostAccount(baseUrl as string, me);
      const updates: ServerLogoutHoldUpdate[] = [];
      let held: Subscription | undefined;
      try {
        held = proxyEngine<SessionEngine>('session', host)
          .holdServerLogout(me.userId)
          .subscribe((update) => updates.push(update));
        await expect
          .poll(() => updates.length, { timeout: 10_000 })
          .toBeGreaterThan(0);
        const revoked = await fetch(`${baseUrl}/_matrix/client/v3/logout`, {
          method: 'POST',
          headers: { authorization: `Bearer ${me.accessToken}` },
        });
        expect(revoked.ok).toBe(true);

        let seen: string[] = [];
        const result = await firstValueFrom(
          proxyEngine<ContactAddressesEngine>('contactAddresses', host)
            .threePids(me.userId)
            .pipe(tap(() => (seen = updates.map((u) => u.kind)))),
        );

        expect(seen).toContain('token-died');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.failure.code).toBe('request-failed');
      } finally {
        held?.unsubscribe();
        await host.dispose();
      }
    }, 120_000);
  },
);
