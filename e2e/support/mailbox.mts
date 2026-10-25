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

/**
 * Confirm the password-reset link the way a person does: Synapse shows a page whose form
 * must be posted before the reset is accepted (the add-address link validates on a GET).
 */
export async function confirmResetLink(
  request: APIRequestContext,
  to: string,
  hs: string,
): Promise<void> {
  const link = await latestLink(request, to, hs);
  const page = await request.get(link);
  const html = await page.text();
  expect(page.ok(), `reset link page: ${page.status()} ${html}`).toBe(true);

  const hidden = (name: string): string => {
    const input = html
      .match(/<input\b[^>]*>/giu)
      ?.find((tag) => new RegExp(`name=["']${name}["']`, 'iu').test(tag));
    const value = input?.match(/value=["']([^"']*)["']/iu)?.[1];
    if (value === undefined) {
      throw new Error(`the reset link page has no "${name}" field:\n${html}`);
    }
    return value.replaceAll('&amp;', '&');
  };
  const action = html.match(/<form\b[^>]*\baction=["']([^"']*)["']/iu)?.[1];
  const url = new URL((action ?? '').replaceAll('&amp;', '&') || link, link);
  const base = new URL(hs);
  url.protocol = base.protocol;
  url.host = base.host;

  const res = await request.post(url.toString(), {
    form: {
      sid: hidden('sid'),
      token: hidden('token'),
      client_secret: hidden('client_secret'),
    },
  });
  expect(
    res.ok(),
    `confirm reset link: ${res.status()} ${await res.text()}`,
  ).toBe(true);
}
