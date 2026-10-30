import { Injector } from '@angular/core';
import { createHmac } from 'node:crypto';
import { createClient } from 'matrix-js-sdk';
import { describe } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { defineAuthEngineContract } from '../../contract/auth-engine.contract';
import { JsSdkAuthEngine } from './js-sdk-auth-engine';
import { JsSdkQrRendezvous, QrRendezvousFactory } from './qr-rendezvous';

// Runs the engine contract against a live Synapse; skipped unless TRINITY_ENGINE_CONTRACT_HS is
// set. The reset and email registration cases also need the harness's Mailpit.
const baseUrl = process.env['TRINITY_ENGINE_CONTRACT_HS'] as string;
const secret = process.env['TRINITY_ENGINE_CONTRACT_SHARED_SECRET'] ?? '';
const mailpit = process.env['TRINITY_ENGINE_CONTRACT_MAILPIT'];

async function register(localpart: string, admin = false) {
  const api = `${baseUrl}/_synapse/admin/v1/register`;
  const nonceRes = await fetch(api);
  if (!nonceRes.ok)
    throw new Error(`Synapse nonce request failed: ${nonceRes.status}`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const password = `pw-${Math.random().toString(36).slice(2)}`;
  const mac = createHmac('sha1', secret)
    .update(
      `${nonce}\0${localpart}\0${password}\0${admin ? 'admin' : 'notadmin'}`,
    )
    .digest('hex');
  const res = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({ nonce, username: localpart, password, mac, admin }),
  });
  if (!res.ok) throw new Error(`Synapse registration failed: ${res.status}`);
  const body = (await res.json()) as { user_id: string; access_token: string };
  return {
    localpart,
    userId: body.user_id,
    password,
    accessToken: body.access_token,
  };
}

async function admin(
  token: string,
  method: string,
  path: string,
  body: object,
) {
  const res = await fetch(`${baseUrl}/_synapse/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
}

/**
 * Confirms the link Synapse mailed to `email` for `clientSecret`: open it, then post its form
 * when it has one (a reset link asks to confirm; a registration link confirms when opened).
 */
async function confirmMailedLink(email: string, clientSecret: string) {
  for (let i = 0; i < 60; i++) {
    const search = await fetch(
      `${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`,
    );
    const { messages } = (await search.json()) as {
      messages: { ID: string }[];
    };
    for (const { ID } of messages) {
      const { Text } = (await (
        await fetch(`${mailpit}/api/v1/message/${ID}`)
      ).json()) as { Text: string };
      const mailed = Text.match(/https?:\/\/\S+/gu)?.find((url) =>
        url.includes(`client_secret=${clientSecret}`),
      );
      if (!mailed) continue;
      // Synapse builds the link from its public base; reach it where the contract does.
      const link = new URL(mailed);
      const origin = new URL(baseUrl);
      link.protocol = origin.protocol;
      link.host = origin.host;
      const opened = await fetch(link);
      if (!opened.ok) throw new Error(`Mailed link: ${opened.status}`);
      const page = await opened.text();
      const field = (name: string) =>
        page
          .match(new RegExp(`<input[^>]*name=["']${name}["'][^>]*>`, 'iu'))?.[0]
          .match(/value=["']([^"']*)["']/iu)?.[1]
          ?.replaceAll('&amp;', '&') ?? '';
      const form = page.match(/<form\b[^>]*>/iu)?.[0];
      if (!form) return;
      const action = form.match(/\baction=["']([^"']*)["']/iu)?.[1] ?? '';
      const target = new URL(action.replaceAll('&amp;', '&'), link);
      target.protocol = origin.protocol;
      target.host = origin.host;
      const posted = await fetch(target, {
        method: 'POST',
        body: new URLSearchParams({
          sid: field('sid'),
          token: field('token'),
          client_secret: field('client_secret'),
        }),
      });
      if (!posted.ok) throw new Error(`Mailed link form: ${posted.status}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Synapse mailed no link');
}

describe.skipIf(!baseUrl)('JsSdkAuthEngine against Synapse', () => {
  defineAuthEngineContract(
    async () => {
      const unique = Date.now().toString(36);
      const [user, live, reset, root] = await Promise.all([
        register(`auth-a-${unique}`),
        register(`auth-live-${unique}`),
        register(`auth-reset-${unique}`),
        register(`auth-admin-${unique}`, true),
      ]);
      const email = `${reset.localpart}@example.test`;
      await admin(
        root.accessToken,
        'PUT',
        `/v2/users/${encodeURIComponent(reset.userId)}`,
        { threepids: [{ medium: 'email', address: email }] },
      );
      const client = createClient({
        baseUrl,
        userId: live.userId,
        accessToken: live.accessToken,
      });
      const engine = Injector.create({
        providers: [
          {
            provide: JS_SDK_CLIENTS,
            useValue: {
              clientFor: (id: string) => (id === live.userId ? client : null),
            },
          },
          JsSdkQrRendezvous,
          QrRendezvousFactory,
          JsSdkAuthEngine,
        ],
      }).get(JsSdkAuthEngine);
      return {
        engine,
        baseUrl,
        user,
        live,
        reset: {
          ...reset,
          email,
          confirmLink: (clientSecret) => confirmMailedLink(email, clientSecret),
        },
        sessionAlive: async (accessToken) =>
          (
            await fetch(`${baseUrl}/_matrix/client/v3/account/whoami`, {
              headers: { authorization: `Bearer ${accessToken}` },
            })
          ).ok,
        confirmRegistrationLink: confirmMailedLink,
      };
    },
    { mail: Boolean(mailpit) },
  );
});
