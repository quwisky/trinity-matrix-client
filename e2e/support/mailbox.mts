import { expect, type APIRequestContext } from '@playwright/test';
import { MAILPIT_HTTP } from './homeserver/start.mjs';

interface MailpitSearch {
  readonly messages: readonly { readonly ID: string }[];
}

/**
 * The homeserver link in the newest mail Mailpit received for `to`, on `hs`'s origin.
 *
 * Synapse builds the link from `public_baseurl`; the origin is rewritten so the request
 * reaches the address the spec talks to whatever the server put in the mail.
 */
export async function latestLink(
  request: APIRequestContext,
  to: string,
  hs: string,
): Promise<string> {
  let id = '';
  await expect
    .poll(
      async () => {
        const res = await request.get(`${MAILPIT_HTTP}/api/v1/search`, {
          params: { query: `to:"${to}"` },
        });
        const { messages } = (await res.json()) as MailpitSearch;
        id = messages[0]?.ID ?? '';
        return id;
      },
      { timeout: 15_000, message: `no mail for ${to} reached Mailpit` },
    )
    .not.toBe('');
  const message = (await request
    .get(`${MAILPIT_HTTP}/api/v1/message/${id}`)
    .then((res) => res.json())) as { readonly Text: string };
  const link = message.Text.match(/https?:\/\/\S+/gu)?.find((url) =>
    /\/_(matrix|synapse)\//u.test(url),
  );
  if (!link) throw new Error(`the mail to ${to} has no homeserver link`);
  const url = new URL(link);
  const base = new URL(hs);
  url.protocol = base.protocol;
  url.host = base.host;
  return url.toString();
}
