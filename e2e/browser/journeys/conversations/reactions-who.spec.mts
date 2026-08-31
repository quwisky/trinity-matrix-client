import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers "who reacted" (issue #8): a reaction pill names its reactors on hover, and
// the trailing chip opens the full list, grouped by emoji.
//
// Two people react to one message — the logged-in user and a second account whose
// reaction is sent straight over the CS API, which is all the second participant is
// needed for. Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

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
    const runId = `${testResourceId('run')}w`;
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
    // Hover and assert as ONE retried unit, not two statements.
    //
    // The tooltip opens 150ms after the pointer settles (brn's `showDelay`), and this pill
    // lives inside the virtual scroller, which re-measures rows as images resolve and as
    // later events arrive. A row that shifts inside that window leaves the pointer over
    // something else, brn cancels the pending show on the mouseleave, and a bare `hover()`
    // followed by a separate wait then blocks on a tooltip that is never coming — which is
    // what this line did, intermittently, at the default 5s.
    //
    // `toPass` re-hovers at the element's CURRENT position on every attempt, so a shifted
    // row costs a retry instead of the test. The inner timeout is short on purpose: it is a
    // per-attempt budget, and a long one here would spend the whole run inside one doomed
    // attempt rather than re-hovering.
    await expect(async () => {
      await thumbsUp.hover();
      await expect(page.getByRole('tooltip')).toContainText('reacted by You', {
        timeout: 1_000,
      });
    }).toPass({ timeout: 20_000 });

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
});
