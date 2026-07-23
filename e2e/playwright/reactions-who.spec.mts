import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers "who reacted" (issue #8): a reaction pill names its reactors on hover, and
// the trailing chip (or a long press on a pill, the touch route) opens the full list
// grouped by emoji.
//
// Two people react to one message — the logged-in user and a second account whose
// reaction is sent straight over the CS API, which is all the second participant is
// needed for. Needs a Synapse homeserver (Docker); self-skips otherwise.
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

async function loginApi(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return json.access_token as string;
}

interface Seeded {
  reader: SynapseSession;
  roomName: string;
  /** Display name of the second reactor, as the room shows it. */
  otherName: string;
  body: string;
}

/**
 * A room with one message that two members have reacted to: the account the browser
 * signs in as (👍) and a second account (👍 + 🎉, so there is a second section).
 */
async function seedReactedMessage(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<Seeded> {
  const readerUser = `who-reader-${runId}`;
  const otherUser = `who-other-${runId}`;
  const roomName = `Who reacted ${runId}`;
  const body = `react to me ${runId}`;

  await registerUser(request, readerUser, `${readerUser}-pass`);
  await registerUser(request, otherUser, `${otherUser}-pass`);
  const readerToken = await loginApi(
    request,
    hs,
    readerUser,
    `${readerUser}-pass`,
  );
  const otherToken = await loginApi(
    request,
    hs,
    otherUser,
    `${otherUser}-pass`,
  );
  const readerHeaders = { Authorization: `Bearer ${readerToken}` };
  const otherHeaders = { Authorization: `Bearer ${otherToken}` };

  const { room_id: roomId } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: readerHeaders,
      data: { name: roomName, invite: [`@${otherUser}:localhost`] },
    })
    .then((r) => r.json());
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: otherHeaders },
  );

  const { event_id: eventId } = await request
    .put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/who-${runId}`,
      { headers: readerHeaders, data: { msgtype: 'm.text', body } },
    )
    .then((r) => r.json());

  const react = async (
    headers: Record<string, string>,
    key: string,
    txn: string,
  ): Promise<void> => {
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txn}`,
      {
        headers,
        data: {
          'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
        },
      },
    );
  };
  await react(readerHeaders, '👍', `r1-${runId}`);
  await react(otherHeaders, '👍', `r2-${runId}`);
  await react(otherHeaders, '🎉', `r3-${runId}`);

  return {
    reader: {
      available: true,
      hs,
      user: readerUser,
      pass: `${readerUser}-pass`,
    },
    roomName,
    // Synapse leaves a password-registered account's display name as its localpart.
    otherName: otherUser,
    body,
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

test.describe('Who reacted', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('names the reactors on the pill and lists them all in the dialog', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}w`;
    const seeded = await seedReactedMessage(
      request,
      session.hs as string,
      runId,
    );

    await login(page, seeded.reader);
    await openRoom(page, seeded.roomName);

    const row = page.locator('.scroll .msg', { hasText: seeded.body });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });
    const thumbsUp = row
      .first()
      .locator('.reaction:not(.reaction--who)')
      .filter({ hasText: '👍' });

    // The pill names who is behind the count — the local user first, as "You".
    // Loose on the second name: it is whatever the homeserver resolved (display name,
    // a disambiguated one, or the raw mxid) — all of which contain the localpart.
    await expect(thumbsUp).toHaveAttribute(
      'aria-label',
      new RegExp(`^👍 reacted by You and .*${seeded.otherName}`),
      { timeout: 20_000 },
    );
    await thumbsUp.hover();
    await expect(page.getByRole('tooltip')).toContainText('reacted by You');

    // The trailing chip opens the full list.
    await row.first().getByTestId('reactions-who').click();
    const dialog = page.getByTestId('reactions-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // One section per emoji; the first lists both reactors of 👍.
    await expect(dialog.locator('.key')).toHaveCount(2);
    await expect(dialog.getByTestId('reactors-list')).toContainText(
      seeded.otherName,
    );
    await expect(dialog.locator('.reactor')).toHaveCount(2);

    // Switching to 🎉 shows only the other account, who is its sole reactor.
    await dialog.locator('.key').filter({ hasText: '🎉' }).click();
    await expect(dialog.locator('.reactor')).toHaveCount(1);
    await expect(dialog.getByTestId('reactors-list')).toContainText(
      seeded.otherName,
    );
  });

  test('a long press on a pill opens the list without toggling the reaction', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}wl`;
    const seeded = await seedReactedMessage(
      request,
      session.hs as string,
      runId,
    );

    await login(page, seeded.reader);
    await openRoom(page, seeded.roomName);

    const row = page.locator('.scroll .msg', { hasText: seeded.body });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });
    const thumbsUp = row
      .first()
      .locator('.reaction:not(.reaction--who)')
      .filter({ hasText: '👍' });
    await expect(thumbsUp).toContainText('2', { timeout: 20_000 });

    // The touch gesture, driven as the browser would: a pointerdown that is held.
    // (Mouse presses are ignored by design, hence the explicit pointerType.)
    await thumbsUp.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      pointerId: 1,
      clientX: 0,
      clientY: 0,
    });
    const dialog = page.getByTestId('reactions-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Lifting the finger must not also toggle the reaction off — the click the
    // browser synthesises after the gesture is swallowed.
    await thumbsUp.dispatchEvent('pointerup', {
      pointerType: 'touch',
      pointerId: 1,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(thumbsUp).toContainText('2');
  });
});
