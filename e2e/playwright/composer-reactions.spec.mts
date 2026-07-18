import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for the full emoji reaction picker: hover a message, open the quick
// reactions, escalate to the full emoji-mart picker via "+", search and pick an
// emoji, and see it land as a reaction on the message. Needs Synapse (Docker).
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

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

/** Register a user and create a room they own; returns a login session + room name. */
async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ user: SynapseSession; roomName: string }> {
  const username = `react-user-${runId}`;
  const password = `${username}-pass`;
  const roomName = `Reactions E2E ${runId}`;

  await registerUser(request, username, password);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      },
    })
    .then((r) => r.json());
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${access_token}` },
    data: { name: roomName },
  });

  return {
    user: { available: true, hs, user: username, pass: password },
    roomName,
  };
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Full emoji reaction picker', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('reacts with an emoji chosen from the full picker', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}r`;
    const { user, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, user);
    await openRoom(page, roomName);

    // Send a few messages first so the target isn't at the very top — the quick
    // reactions popover opens *above* the row, and a top-of-timeline row would clip
    // it against the scroll container. React to the last message sent.
    const composer = page.getByTestId('composer-input');
    await composer.click();
    const body = `react to me ${runId}`;
    for (const text of ['one', 'two', 'three', body]) {
      await composer.fill(text);
      await composer.press('Enter');
    }

    const row = page.locator('.scroll .msg', { hasText: body });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });

    // Reveal the hover toolbar, open the quick reactions, then escalate to "+".
    // The hover → "Add reaction" → quick-reactions popover chain is a fragile pointer
    // interaction: under full-suite load the popover occasionally doesn't open on the
    // first click (a hover/render race), which a bigger timeout can't fix. Retry the
    // open until react-more actually appears (only ever re-clicks a *closed* popover,
    // since react-more is visible iff the popover is open).
    const reactMore = page.getByTestId('react-more');
    await expect(async () => {
      await row.first().hover();
      await row.first().getByRole('button', { name: 'Add reaction' }).click();
      await expect(reactMore).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    await reactMore.click();

    // The full picker opens in a dialog; drive it through its search box (emoji-mart
    // lazy-renders, so search first) and pick the first result.
    const picker = page.getByTestId('reaction-picker');
    // emoji-mart is a heavy legacy library that lazy-renders — give the dialog the
    // same 20s headroom under load.
    await expect(picker).toBeVisible({ timeout: 20_000 });
    await picker.locator('.emoji-mart-search input').fill('rocket');
    // Wait for the search to actually filter before clicking. emoji-mart re-renders its
    // results asynchronously, so ".emoji-mart-emoji:visible first" can still be a stale
    // pre-search emoji — clicking it sends the wrong reaction and 🚀 never lands. Target
    // the rocket by its label and wait for it, which also confirms the filter applied.
    const rocket = picker.locator('.emoji-mart-emoji[aria-label*="rocket" i]');
    await expect(rocket.first()).toBeVisible({ timeout: 15_000 });
    await rocket.first().click();

    // The chosen reaction lands on the message.
    await expect(
      page.locator('.scroll .reaction', { hasText: '🚀' }).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
