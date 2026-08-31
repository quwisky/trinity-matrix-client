import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../fixtures.mts';
import {
  isAndroidE2E,
  login,
  openMessageActionSheet,
  synapseSession,
  type SynapseSession,
} from '../support/app.mts';
import { registerUser } from '../support/account.mts';

// End-to-end for the full emoji reaction picker: hover a message, open the quick
// reactions, escalate to the full emoji-mart picker via "+", search and pick an
// emoji, and see it land as a reaction on the message. Needs Synapse (Docker).
const session = synapseSession();

/** Register a user and create a room they own; returns a login session + room name. */
async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  user: SynapseSession;
  roomName: string;
  roomId: string;
  headers: { Authorization: string };
}> {
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
  const headers = { Authorization: `Bearer ${access_token}` };
  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName },
    })
    .then((response) => response.json())
    .then((json) => json.room_id as string);

  return {
    user: { available: true, hs, user: username, pass: password },
    roomName,
    roomId,
    headers,
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

  test('opens and closes the composer’s own picker from its button', async ({
    page,
    request,
  }) => {
    // The composer's emoji picker had NO e2e coverage at all, which is how it shipped
    // unclosable: it moved into the CDK overlay container, its trigger stayed in the row the
    // overlay anchors to, and a press there reached CDK's outside-press dispatcher as well as
    // the button's own handler. Both wrote the same signal. The second click left the state
    // saying open with nothing rendered — and 202 e2e tests passed, because none of them ever
    // closed it.
    const runId = `${testResourceId('run')}p`;
    const { user, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, user);
    await openRoom(page, roomName);

    const trigger = page.getByRole('button', { name: 'Insert emoji' });
    const picker = page.locator('trn-emoji-picker');

    await trigger.click();
    await expect(picker).toBeVisible({ timeout: 20_000 });
    // The trigger has to agree with what is on screen, which is the half that desynced.
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await trigger.click();
    await expect(picker).toBeHidden({ timeout: 10_000 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('reacts with an emoji chosen from the full picker', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}r`;
    const { user, roomName, roomId, headers } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    // These events only position the reaction target away from the timeline's top edge;
    // seed them through the CS API so the picker test does not depend on four unrelated,
    // consecutive composer sends settling under full-suite load.
    const body = `react to me ${runId}`;
    for (const [index, text] of ['one', 'two', 'three', body].entries()) {
      await request.put(
        `${session.hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/react-${runId}-${index}`,
        { headers, data: { msgtype: 'm.text', body: text } },
      );
    }

    await login(page, user);
    await openRoom(page, roomName);

    // Seed a few messages first so the target isn't at the very top — the quick
    // reactions popover opens *above* the row, and a top-of-timeline row would clip
    // it against the scroll container. React to the last seeded message.

    const row = page.locator('.scroll .msg', { hasText: body });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });

    // Android deliberately has no hover toolbar: a long press opens the native action
    // sheet, whose "More reactions…" action reaches the same full picker. Desktop keeps
    // its hover toolbar → quick reactions → "+" interaction below.
    const dialog = page.getByRole('dialog', { name: 'Pick a reaction' });
    if (isAndroidE2E) {
      const sheet = await openMessageActionSheet(page, row.first());
      await sheet.getByTestId('sheet-react-more').click();
      await expect(dialog).toBeVisible({ timeout: 10_000 });
    }

    // Reveal the hover toolbar, open the quick reactions, then escalate to "+".
    // The hover → "Add reaction" → quick-reactions popover chain is a fragile pointer
    // interaction: under full-suite load the popover occasionally doesn't open on the
    // first click (a hover/render race), which a bigger timeout can't fix. Retry the
    // open until react-more actually appears (only ever re-clicks a *closed* popover,
    // since react-more is visible iff the popover is open).
    // The click on react-more belongs INSIDE the retry, not after it. Asserting
    // visibility and then clicking are two moments: the popover can close between them
    // (the row re-renders, the pointer has not moved, so :hover no longer applies), and
    // the click then waits out the whole 120s test timeout on an element that is never
    // coming back. Bounding it at 5s turns that hang into another attempt instead.
    const reactMore = page.getByTestId('react-more');
    if (!isAndroidE2E) {
      await expect(async () => {
        if (await dialog.isVisible()) return;
        if (!(await reactMore.isVisible())) {
          await row.first().hover();
          await row
            .first()
            .getByRole('button', { name: 'Add reaction' })
            .click({ timeout: 2_000 });
        }
        await reactMore.click({ timeout: 2_000 });
        await expect(dialog).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
    }

    // The full picker opens in a dialog; drive it through its search box (emoji-mart
    // lazy-renders, so search first) and pick the first result.
    //
    // Addressed as "the picker inside the reaction dialog" rather than by a testid of its
    // own: the panel is the kit's `<trn-emoji-picker>` at both call sites and carries the
    // kit's `emoji-picker` handle, so what separates this one from the composer's is the
    // dialog around it. Naming that dialog also asserts its accessible name, which is the
    // only thing a screen reader has to go on here.
    const picker = dialog.getByTestId('emoji-picker');
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
