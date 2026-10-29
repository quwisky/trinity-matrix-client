import { Injector } from '@angular/core';
import { createHmac } from 'node:crypto';
import { createClient } from 'matrix-js-sdk';
import { describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineContactAddressesEngineContract } from '../../contract/contact-addresses-engine.contract';
import {
  agreeToTerms,
  getTerms,
  hashedLookup,
  newClientSecret,
  registerWithIdentityServer,
  requestEmailToken,
} from '../identity-server-http';
import { JsSdkContactAddressesEngine } from './js-sdk-contact-addresses-engine';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is
// set. The mail cases need the harness's Mailpit, the identity cases Sydent too.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'];
const serverName = process.env['TRINITY_ENGINE_CONTRACT_SERVER_NAME'] ?? '';
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const identityUrl = process.env['TRINITY_ENGINE_CONTRACT_IDENTITY'];
const mailpit = process.env['TRINITY_ENGINE_CONTRACT_MAILPIT'];

async function register(username: string, admin = false) {
  const api = `${baseUrl}/_synapse/admin/v1/register`;
  const nonceRes = await fetch(api);
  if (!nonceRes.ok)
    throw new Error(`Synapse nonce request failed: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const mac = createHmac('sha1', secret)
    .update(
      `${nonce}\0${username}\0${password}\0${admin ? 'admin' : 'notadmin'}`,
    )
    .digest('hex');
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({ nonce, username, password, mac, admin }),
  });
  if (!res.ok) throw new Error(`Synapse registration failed: ${res.status}`);
  const user = (await res.json()) as { user_id: string; access_token: string };
  return { ...user, password };
}

/** Opens the link mailed to `address` for `clientSecret` at `origin`, as a person would. */
async function openMailedLink(
  address: string,
  clientSecret: string,
  origin: string,
) {
  for (let i = 0; i < 60; i++) {
    const search = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    const { messages } = (await search.json()) as {
      messages: { ID: string }[];
    };
    for (const { ID } of messages) {
      const { Text } = (await (
        await fetch(`${mailpit}/api/v1/message/${ID}`)
      ).json()) as { Text: string };
      const link = Text.match(/https?:\/\/\S+/gu)?.find((url) =>
        url.includes(`client_secret=${clientSecret}`),
      );
      if (!link) continue;
      // Servers build the link from their own public base; reach it where the contract does.
      const { pathname, search: query } = new URL(link);
      const opened = await fetch(`${origin}${pathname}${query}`);
      if (!opened.ok) throw new Error(`Validation link: ${opened.status}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('No validation link was mailed');
}

describe.skipIf(!baseUrl)('JsSdkContactAddressesEngine against Synapse', () => {
  defineContactAddressesEngineContract(
    async () => {
      const unique = Date.now().toString(36);
      const address = `ca-${unique}@example.test`;
      const [me, admin] = await Promise.all([
        register(`ca-${unique}`),
        register(`ca-admin-${unique}`, true),
      ]);
      const added = await fetch(
        `${baseUrl}/_synapse/admin/v2/users/${encodeURIComponent(me.user_id)}`,
        {
          method: 'PUT',
          headers: { authorization: `Bearer ${admin.access_token}` },
          body: JSON.stringify({
            threepids: [{ medium: 'email', address }],
          }),
        },
      );
      if (!added.ok) throw new Error(`Adding the address: ${added.status}`);
      const client = createClient({
        baseUrl: baseUrl as string,
        userId: me.user_id,
        accessToken: me.access_token,
      });
      const engine = Injector.create({
        providers: [
          {
            provide: JS_SDK_CLIENTS,
            useValue: {
              clientFor: (id: string) => (id === me.user_id ? client : null),
            },
          },
          JsSdkContactAddressesEngine,
        ],
      }).get(JsSdkContactAddressesEngine);

      const identity = async () => {
        const base = identityUrl as string;
        const openId = await client.getOpenIdToken();
        const idAccessToken = await registerWithIdentityServer(base, {
          accessToken: openId.access_token,
          tokenType: openId.token_type,
          matrixServerName: openId.matrix_server_name,
          expiresIn: openId.expires_in,
        });
        const policies = await getTerms(base);
        await agreeToTerms(
          base,
          idAccessToken,
          Object.values(policies).flatMap((policy) =>
            Object.values(policy).flatMap((entry) =>
              typeof entry === 'object' && entry && 'url' in entry
                ? [String(entry.url)]
                : [],
            ),
          ),
        );
        const session = async () => {
          const clientSecret = newClientSecret();
          const sid = await requestEmailToken(base, idAccessToken, {
            email: address,
            clientSecret,
            sendAttempt: 1,
          });
          return { sid, clientSecret, idAccessToken };
        };
        return {
          idServer: new URL(base).host,
          // The homeserver's own host: natively it answers 404, which Synapse records as
          // no-support; Docker Synapse cannot reach it and fails the unbind.
          otherIdServer: new URL(baseUrl as string).host,
          unvalidatedSession: session,
          validatedSession: async () => {
            const opened = await session();
            await openMailedLink(address, opened.clientSecret, base);
            return opened;
          },
          lookup: async (asked: string) =>
            (await hashedLookup(base, idAccessToken, [asked]))[0]?.mxid ?? null,
        };
      };

      let newAddresses = 0;
      return {
        engine,
        accountId: me.user_id,
        address,
        password: me.password,
        serverName,
        wellKnownIdentityServer: null,
        ...(mailpit
          ? {
              mail: {
                newAddress: () => `ca-${unique}-${++newAddresses}@example.test`,
                openLink: (to: string, clientSecret: string) =>
                  openMailedLink(to, clientSecret, baseUrl as string),
              },
            }
          : {}),
        ...(identityUrl && mailpit ? { identity: await identity() } : {}),
      };
    },
    { identity: Boolean(identityUrl && mailpit), mail: Boolean(mailpit) },
  );
});
