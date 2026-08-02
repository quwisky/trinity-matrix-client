import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for the mobile (narrow-viewport) room navigation the desktop specs
// never exercise, since the shared config runs at Desktop Chrome (1280px):
//  - the room header collapses its secondary actions (Invite / Room settings /
//    Pinned / Members) into an overflow (⋮) menu below the md breakpoint, keeping
//    only Search + Threads inline (rooms.page.html);
//  - the member list, a static column at ≥1100px, becomes a slide-in drawer with a
//    dismissing backdrop below that, opened from the overflow menu and closed by the
//    backdrop or by selecting a member.
// Runs at a phone viewport so the width-based breakpoints (max-md / max-[1100px] /
// matchMedia) engage. Drives a real Synapse room with a second member; self-skips
// without Docker like the other authenticated web specs.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

// A phone viewport: below md (768) so the header uses the kebab, and below 1100 so
// the member list is a drawer.
test.use({ viewport: { width: 390, height: 844 } });

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

/** Register a user via Synapse's shared-secret admin endpoint (idempotent). */
async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const nonceRes = await request.get(
    `${SYNAPSE_HTTP}/_synapse/admin/v1/register`,
  );
  const { nonce } = await nonceRes.json();
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
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  const json = await res.json();
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/** Give a user a stable display name so a member row can be matched by name. */
async function setDisplayName(
  request: APIRequestContext,
  hs: string,
  actor: ApiUser,
  name: string,
): Promise<void> {
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(actor.userId)}/displayname`,
    { headers: actor.headers, data: { displayname: name } },
  );
}

/**
 * Register a reader plus one extra member, have the reader create a plain (non-DM)
 * room inviting the extra, and have the extra join — a synced two-member room the
 * reader can open from their list.
 */
async function seedRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; roomName: string; buddyName: string }> {
  const readerUser = `mob-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);

  const buddyUser = `mob-buddy-${runId}`;
  const buddyPass = `${buddyUser}-pass`;
  await registerUser(request, buddyUser, buddyPass);
  const buddy = await apiLogin(request, hs, buddyUser, buddyPass);
  const buddyName = `Mobile Buddy ${runId}`;
  await setDisplayName(request, hs, buddy, buddyName);

  const roomName = `Mobile E2E ${runId}`;
  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: roomName, invite: [buddy.userId] },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: buddy.headers },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
    buddyName,
  };
}

/** Open the seeded room on the narrow layout: the room list is the mobile home page,
 * so pick the Rooms rail then the room — selecting it switches to the chat page. */
async function openRoomMobile(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click(); // switches from the list page to the chat page
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });
}

/** Open the room-header overflow (⋮) menu. */
async function openOverflowMenu(page: Page): Promise<void> {
  await page.getByTestId('room-actions-overflow').click();
}

test.describe('Mobile room navigation', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('collapses the room header actions into an overflow menu', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}k`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoomMobile(page, roomName);

    // Primary actions stay inline; the secondary ones are demoted (max-md:hidden).
    await expect(page.getByTestId('search-messages')).toBeVisible();
    await expect(page.getByTestId('open-threads')).toBeVisible();
    await expect(page.getByTestId('invite-people')).toBeHidden();
    await expect(page.getByTestId('open-room-settings')).toBeHidden();
    await expect(page.getByTestId('open-pinned')).toBeHidden();
    await expect(page.getByTestId('toggle-members')).toBeHidden();

    // The overflow kebab is present and reveals the demoted actions.
    await expect(page.getByTestId('room-actions-overflow')).toBeVisible();
    await openOverflowMenu(page);
    await expect(page.getByTestId('overflow-invite-people')).toBeVisible();
    await expect(page.getByTestId('overflow-open-room-settings')).toBeVisible();
    await expect(page.getByTestId('overflow-open-pinned')).toBeVisible();
    await expect(page.getByTestId('overflow-toggle-members')).toBeVisible();
  });

  test('opens the member list as a dismissible drawer', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}d`;
    const { reader, roomName, buddyName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoomMobile(page, roomName);

    // The member list is not shown on the narrow layout by default.
    await expect(page.locator('.chat-members')).toBeHidden();

    // Opening it from the overflow menu shows a drawer plus a backdrop.
    await openOverflowMenu(page);
    await page.getByTestId('overflow-toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible();
    await expect(page.getByTestId('members-backdrop')).toBeVisible();
    // Both the reader and the buddy have synced into the list.
    await expect(page.locator('.members .member')).toHaveCount(2, {
      timeout: 20_000,
    });

    // Tapping the backdrop dismisses the drawer — near its top-left corner, deliberately.
    // The backdrop is `inset-0`, so its centre (195,422 at this viewport) lies *under* the
    // 240px drawer pinned to the right edge (x 150-390), and Playwright clicks an element's
    // centre by default. Measured: elementFromPoint at the centre is `aside.members`, at
    // (10,10) it is the backdrop. This only ever passed because the click raced the 0.2s
    // slide-in animation while the drawer was still translated off-screen; once the drawer
    // settles the click is blocked forever, which is what it does on a slower CI runner.
    await page
      .getByTestId('members-backdrop')
      .click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.chat-members')).toBeHidden();

    // Reopen and pick the buddy: the info panel opens and the drawer closes with it.
    await openOverflowMenu(page);
    await page.getByTestId('overflow-toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible();
    await page.locator('.members .member', { hasText: buddyName }).click();
    await expect(page.getByTestId('member-info')).toBeVisible();
    await expect(page.locator('.chat-members')).toBeHidden();
  });

  test('Escape dismisses the member drawer, and only when it is open', async ({
    page,
    request,
  }) => {
    // The drawer's backdrop is mouse-only, so Escape is the keyboard path to dismissing
    // it — and it had no coverage of any kind: it is reachable only through a `host`
    // binding, which the unit spec cannot drive because it never renders the page.
    const runId = `${Date.now().toString(36)}e`;
    const { reader, roomName } = await seedRoom(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoomMobile(page, roomName);

    await openOverflowMenu(page);
    await page.getByTestId('overflow-toggle-members').click();
    await expect(page.locator('.chat-members')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.chat-members')).toBeHidden();
    await expect(page.getByTestId('members-backdrop')).toBeHidden();

    // The binding is scoped to the drawer being open, so a second Escape must not
    // navigate away or close the room — otherwise it would swallow the key everywhere.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('composer-input')).toBeVisible();
  });
});
