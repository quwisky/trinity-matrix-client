import { registerSynapseUser, synapseRequest } from '@trinity/testing';
import {
  agreeToTerms,
  getTerms,
  hashedLookup,
  newClientSecret,
  registerWithIdentityServer,
  requestEmailToken,
} from '../lib/identity-server-http';
import type { ContactAddressesContractSetup } from './contact-addresses-engine.contract';

type SynapseUser = Awaited<ReturnType<typeof registerSynapseUser>>;

/** Opens the link mailed to `address` for `clientSecret` at `origin`, as a person would. */
async function openMailedLink(
  mailpit: string,
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

/**
 * Everything the contact-addresses contract needs from a live Synapse but the engine: a fresh
 * account `me` holding `ca-<unique>@example.test`, and the mail and identity-server drivers for
 * the services `env` names. No client is started, so each spec builds its engine from `me`.
 */
export async function contactAddressesSynapseFixture(env: {
  baseUrl: string;
  serverName: string;
  secret: string;
  mailpit?: string;
  identityUrl?: string;
}): Promise<
  { me: SynapseUser } & Omit<
    ContactAddressesContractSetup,
    'engine' | 'accountId'
  >
> {
  const { baseUrl, serverName, secret, mailpit, identityUrl } = env;
  const unique = Date.now().toString(36);
  const address = `ca-${unique}@example.test`;
  const [me, admin] = await Promise.all([
    registerSynapseUser(baseUrl, secret, `ca-${unique}`),
    registerSynapseUser(baseUrl, secret, `ca-admin-${unique}`, true),
  ]);
  const added = await fetch(
    `${baseUrl}/_synapse/admin/v2/users/${encodeURIComponent(me.userId)}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${admin.accessToken}` },
      body: JSON.stringify({
        threepids: [{ medium: 'email', address }],
      }),
    },
  );
  if (!added.ok) throw new Error(`Adding the address: ${added.status}`);

  const identity = async (base: string, mailbox: string) => {
    const openId = await synapseRequest<{
      access_token: string;
      token_type: string;
      matrix_server_name: string;
      expires_in: number;
    }>(
      baseUrl,
      me.accessToken,
      'POST',
      `/user/${encodeURIComponent(me.userId)}/openid/request_token`,
      {},
    );
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
      otherIdServer: new URL(baseUrl).host,
      unvalidatedSession: session,
      validatedSession: async () => {
        const opened = await session();
        await openMailedLink(mailbox, address, opened.clientSecret, base);
        return opened;
      },
      lookup: async (asked: string) =>
        (await hashedLookup(base, idAccessToken, [asked]))[0]?.mxid ?? null,
    };
  };

  let newAddresses = 0;
  return {
    me,
    address,
    password: me.password,
    serverName,
    wellKnownIdentityServer: null,
    ...(mailpit
      ? {
          mail: {
            newAddress: () => `ca-${unique}-${++newAddresses}@example.test`,
            openLink: (to: string, clientSecret: string) =>
              openMailedLink(mailpit, to, clientSecret, baseUrl),
          },
        }
      : {}),
    ...(identityUrl && mailpit
      ? { identity: await identity(identityUrl, mailpit) }
      : {}),
  };
}
