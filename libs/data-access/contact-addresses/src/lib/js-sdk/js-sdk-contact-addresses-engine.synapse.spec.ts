import { Injector } from '@angular/core';
import { createClient } from 'matrix-js-sdk';
import { describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineContactAddressesEngineContract } from '../../contract/contact-addresses-engine.contract';
import { contactAddressesSynapseFixture } from '../../contract/contact-addresses-synapse-fixture';
import { JsSdkContactAddressesEngine } from './js-sdk-contact-addresses-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is
// set. The mail cases need the harness's Mailpit, the identity cases Sydent too.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const identityUrl = process.env['TRINITY_ENGINE_CONTRACT_IDENTITY'];
const mailpit = process.env['TRINITY_ENGINE_CONTRACT_MAILPIT'];

describe.skipIf(!baseUrl)('JsSdkContactAddressesEngine against Synapse', () => {
  defineContactAddressesEngineContract(
    async () => {
      const { me, ...fixture } = await contactAddressesSynapseFixture({
        baseUrl: baseUrl as string,
        serverName,
        secret,
        mailpit,
        identityUrl,
      });
      const client = createClient({
        baseUrl: baseUrl as string,
        userId: me.userId,
        accessToken: me.accessToken,
      });
      const engine = Injector.create({
        providers: [
          {
            provide: JS_SDK_CLIENTS,
            useValue: {
              clientFor: (id: string) => (id === me.userId ? client : null),
            },
          },
          JsSdkContactAddressesEngine,
        ],
      }).get(JsSdkContactAddressesEngine);
      return { engine, accountId: me.userId, ...fixture };
    },
    { identity: Boolean(identityUrl && mailpit), mail: Boolean(mailpit) },
  );
});
