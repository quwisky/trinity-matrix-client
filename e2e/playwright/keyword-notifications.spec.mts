import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers keyword notification rules (Settings → Notifications → Keywords). Adding a word
// writes a `content` push rule keyed by the word itself, and a message containing it must
// then HIGHLIGHT the room for the reader — which is the homeserver's own push-rule
// evaluation, not anything this client re-implements.
//
// The highlight badge is the honest end of the assertion: a desktop notification cannot be
// observed from Playwright, but the red `.channel__badge` is driven by the same
// `highlight` tweak the rule sets, through the same server-side scoring.
// Needs a Synapse homeserver (Docker); self-skips otherwise like the other web specs.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

/** A word no other rule could match, so the highlight can only come from our keyword. */
const KEYWORD = 'zarquon';

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

test.describe('Keyword notifications', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a keyword added in settings highlights the room when someone says it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}k`;
    const readerUser = `kw-reader-${runId}`;
    const readerPass = `${readerUser}-pass`;
    const senderUser = `kw-sender-${runId}`;
    const senderPass = `${senderUser}-pass`;
    const roomName = `Keyword E2E ${runId}`;

    await registerUser(request, readerUser, readerPass);
    await registerUser(request, senderUser, senderPass);
    const reader = await apiLogin(request, hs, readerUser, readerPass);
    const sender = await apiLogin(request, hs, senderUser, senderPass);

    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: reader.headers,
        data: { name: roomName, invite: [sender.userId] },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: sender.headers },
    );

    /** The keyword's content rule as the server holds it, or undefined. */
    const contentRule = async (): Promise<
      { actions: unknown[]; pattern?: string } | undefined
    > => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/pushrules/global/content/${encodeURIComponent(KEYWORD)}`,
        { headers: reader.headers },
      );
      return res.ok() ? await res.json() : undefined;
    };
    expect(await contentRule()).toBeUndefined(); // nothing to begin with

    await login(page, {
      available: true,
      hs,
      user: readerUser,
      pass: readerPass,
    } as SynapseSession);
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-notifications').click();
    await page.waitForURL(/\/settings\/notifications$/, { timeout: 20_000 });

    const input = page.getByTestId('keyword-input');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(KEYWORD);
    await page.getByTestId('keyword-add').click();

    // It round-trips: the rule exists server-side, keyed by the word itself so a
    // keyword list moves between clients rather than each accumulating duplicates.
    await expect.poll(contentRule, { timeout: 20_000 }).toBeDefined();
    const rule = await contentRule();
    expect(rule?.pattern).toBe(KEYWORD);

    // …and the list shows it back, read from the refreshed rules rather than guessed.
    await expect(page.getByTestId('keyword-row')).toHaveCount(1);
    await expect(page.getByTestId('keyword-row')).toContainText(KEYWORD);

    // Leave settings so the room list is on screen; do NOT open the room, or reading it
    // would clear the very badge being asserted.
    await page.goto('/rooms');
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });

    // PUT with a transaction id — `/send` has no POST form, and a wrong verb here fails
    // silently as "the badge just never appeared", so the response is checked.
    const sent = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/kw-${runId}`,
      {
        headers: sender.headers,
        data: { msgtype: 'm.text', body: `did someone say ${KEYWORD}?` },
      },
    );
    expect(sent.ok()).toBe(true);

    // The highlight badge — not merely an unread one — is what proves the homeserver
    // scored the keyword rule and applied its `highlight` tweak.
    const highlight = channel
      .first()
      .locator('.channel__badge:not(.channel__badge--muted)');
    await expect(highlight).toBeVisible({ timeout: 30_000 });
    await expect(highlight).toHaveAttribute('aria-label', /unread mentions/);
  });
});
