import { setTimeout as wait } from 'node:timers/promises';
import type { APIResponse } from '@playwright/test';
import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { login, waitForRooms } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsFromRooms,
} from '../../../support/journeys/navigation.mts';
import {
  addAccountViaUi,
  apiLogin,
  configureMultiAccountSuite,
  postMessage,
  session,
  type ApiUser,
} from '../../support/multi-account-journey.mts';
import { openSection } from '../../support/settings-journey.mts';

// End-to-end for the space rail's unread chats (issue #893): chats with new messages from
// EVERY signed-in account are listed under Rooms, newest first, each naming its account when
// it is not the one on screen. Reading a chat takes it off the rail, the entry count follows
// the "Space rail" setting, and the choice is saved per device and exported with the rest of
// the settings. Needs a Synapse homeserver (Docker); self-skips otherwise.

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rail's own section of unread chats. */
const railSection = (page: Page) =>
  page.locator('trn-server-rail').getByTestId('rail-unread-chats');

const railEntries = (page: Page) =>
  page.locator('trn-server-rail').getByTestId('rail-unread-chat');

/** The entry whose button is named for `room` ("{room} · {N} unread ..."). */
const railEntry = (page: Page, room: string) =>
  railEntries(page).filter({
    has: page.getByRole('button', {
      name: new RegExp(`^${escapeRegExp(room)} · \\d+ unread`),
    }),
  });

/** The accessible names of every entry, top to bottom. */
const railEntryNames = (page: Page): Promise<(string | null)[]> =>
  railEntries(page)
    .getByRole('button')
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label')),
    );

const overflowEntry = (page: Page) =>
  page.locator('trn-server-rail').getByTestId('rail-unread-overflow');

/**
 * Synapse rate-limits joins per user (burst of 10, then one every ten seconds), and creating
 * or joining a room counts as one. Seeding more than ten rooms for one account therefore
 * meets a 429, so honour its `retry_after_ms` (bounded) and send again.
 */
async function sendWithRetry(
  label: string,
  send: () => Promise<APIResponse>,
): Promise<APIResponse> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await send();
    if (response.status() !== 429) {
      expect(response.ok(), `${label}: ${response.status()}`).toBe(true);
      return response;
    }
    const body = (await response.json().catch(() => ({}))) as {
      retry_after_ms?: number;
    };
    await wait(
      Math.min(Math.max(Number(body.retry_after_ms) || 1_000, 1), 15_000),
    );
  }
  throw new Error(`${label}: still rate-limited after 6 attempts`);
}

/** Create a room as `reader`, bring `sender` in, and have `sender` post `messages` messages. */
async function seedUnreadRoom(
  request: APIRequestContext,
  hs: string,
  reader: ApiUser,
  sender: ApiUser,
  name: string,
  txnPrefix: string,
  messages = 1,
): Promise<string> {
  const created = await sendWithRetry(`createRoom ${name}`, () =>
    request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name, preset: 'private_chat', invite: [sender.userId] },
    }),
  );
  const roomId = (await created.json()).room_id as string;
  await sendWithRetry(`join ${name}`, () =>
    request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: sender.headers },
    ),
  );
  for (let i = 0; i < messages; i++) {
    await postMessage(
      request,
      hs,
      sender,
      roomId,
      `${txnPrefix}-${i}`,
      `message ${i}`,
    );
  }
  return roomId;
}

async function setDisplayName(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
  displayname: string,
): Promise<void> {
  const res = await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(user.userId)}/displayname`,
    { headers: user.headers, data: { displayname } },
  );
  expect(res.ok(), `displayname ${displayname}`).toBe(true);
}

let probeCount = 0;

/** The server's own unread notification count for `roomId`, as `reader` sees it. */
async function serverUnreadCount(
  request: APIRequestContext,
  hs: string,
  reader: ApiUser,
  roomId: string,
): Promise<number> {
  // Synapse caches the response to an identical sync request for a couple of minutes, so a
  // repeated probe would keep returning the first answer. A filter that differs by an unused
  // account-data type is a different request every time.
  const filter = JSON.stringify({
    room: { rooms: [roomId], timeline: { limit: 1 } },
    presence: { types: [] },
    account_data: { types: [`probe.${++probeCount}.${Date.now()}`] },
  });
  const res = await request.get(
    `${hs}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(filter)}`,
    { headers: reader.headers },
  );
  const json = await res.json();
  return (
    (json.rooms?.join?.[roomId]?.unread_notifications?.notification_count as
      number | undefined) ?? -1
  );
}

/**
 * Two readers and one sender. The sender writes to a room shared with A, then to a room
 * shared with B, so B's chat is the newest. A also owns a quiet room nobody has written to.
 */
async function seedTwoAccounts(
  request: APIRequestContext,
  hs: string,
  runId: string,
) {
  const userA = `rail-a-${runId}`;
  const passA = `rail-a-pass-${runId}`;
  const userB = `rail-b-${runId}`;
  const passB = `rail-b-pass-${runId}`;
  const senderUser = `rail-s-${runId}`;
  const senderPass = `rail-s-pass-${runId}`;
  const nameA = `Rail Reader A ${runId}`;
  const nameB = `Rail Reader B ${runId}`;
  const roomA = `Room for A ${runId}`;
  const roomB = `Room for B ${runId}`;
  const quietA = `Quiet A ${runId}`;

  await registerUser(request, userA, passA);
  await registerUser(request, userB, passB);
  await registerUser(request, senderUser, senderPass);
  const a = await apiLogin(request, hs, userA, passA);
  const b = await apiLogin(request, hs, userB, passB);
  const sender = await apiLogin(request, hs, senderUser, senderPass);
  await setDisplayName(request, hs, a, nameA);
  await setDisplayName(request, hs, b, nameB);

  const quiet = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: a.headers,
    data: { name: quietA, preset: 'private_chat' },
  });
  expect(quiet.ok(), 'createRoom quiet').toBe(true);

  const roomAId = await seedUnreadRoom(
    request,
    hs,
    a,
    sender,
    roomA,
    `${runId}-a`,
  );
  const roomBId = await seedUnreadRoom(
    request,
    hs,
    b,
    sender,
    roomB,
    `${runId}-b`,
  );
  return {
    a,
    b,
    userA,
    passA,
    userB,
    passB,
    nameA,
    nameB,
    roomA,
    roomB,
    quietA,
    roomAId,
    roomBId,
  };
}

/** One reader with `count` rooms that each hold one unread message. */
async function seedUnreadRooms(
  request: APIRequestContext,
  hs: string,
  runId: string,
  count: number,
) {
  const user = `rail-r-${runId}`;
  const pass = `rail-r-pass-${runId}`;
  const senderUser = `rail-w-${runId}`;
  const senderPass = `rail-w-pass-${runId}`;
  await registerUser(request, user, pass);
  await registerUser(request, senderUser, senderPass);
  const reader = await apiLogin(request, hs, user, pass);
  const sender = await apiLogin(request, hs, senderUser, senderPass);
  const rooms: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `Unread ${String(i).padStart(2, '0')} ${runId}`;
    await seedUnreadRoom(request, hs, reader, sender, name, `${runId}-${i}`);
    rooms.push(name);
  }
  return { user, pass, rooms };
}

/** Open Settings › Appearance and choose how many unread chats the rail lists. */
async function chooseRailUnreadChats(
  page: Page,
  option: 'up-to-5' | 'all' | 'off',
): Promise<void> {
  await openSettingsFromRooms(page);
  await openSection(page, 'appearance');
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByTestId('space-rail-unread-chats')).toBeVisible();
  await dialog
    .getByTestId('space-rail-unread-chats-select')
    .locator('button')
    .click();
  await page.getByTestId(`space-rail-unread-chats-${option}`).click();
  // The options live in an overlay that goes once a choice is made.
  await expect(
    page.getByTestId(`space-rail-unread-chats-${option}`),
  ).toHaveCount(0);
}

test.describe('Space rail unread chats', () => {
  configureMultiAccountSuite();

  test('two accounts list newest first, and only the other account’s chat names its account', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ru1`;
    const s = await seedTwoAccounts(request, hs, runId);

    // Sign in A, then add B: B is the account on screen.
    await login(page, { available: true, hs, user: s.userA, pass: s.passA });
    await addAccountViaUi(page, hs, s.userB, s.passB);
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${s.userB}:`,
    );

    // Both accounts' chats are listed although only B is selected, newest first: the
    // sender wrote to B's room last.
    await expect(railSection(page)).toBeVisible({ timeout: 30_000 });
    await expect(railEntries(page)).toHaveCount(2, { timeout: 30_000 });
    await expect
      .poll(() => railEntryNames(page), { timeout: 30_000 })
      .toEqual([`${s.roomB} · 1 unread`, `${s.roomA} · 1 unread · ${s.nameA}`]);

    // A's chat belongs to an account other than the one on screen, so it carries A's badge;
    // B's chat is on the active account and carries none.
    await expect(
      railEntry(page, s.roomA).getByTestId('account-badge'),
    ).toBeVisible();
    await expect(
      railEntry(page, s.roomB).getByTestId('account-badge'),
    ).toHaveCount(0);
    await expect(
      railEntry(page, s.roomB).getByTestId('rail-unread-count'),
    ).toHaveText('1');
  });

  test('opening an entry switches account, and reading takes the chat off the rail for good', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ru2`;
    const s = await seedTwoAccounts(request, hs, runId);

    await login(page, { available: true, hs, user: s.userA, pass: s.passA });
    await addAccountViaUi(page, hs, s.userB, s.passB);
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${s.userB}:`,
    );
    await expect(railEntry(page, s.roomA)).toBeVisible({ timeout: 30_000 });
    expect(await serverUnreadCount(request, hs, s.a, s.roomAId)).toBe(1);

    // Opening A's chat from the rail makes A the account on screen and shows the chat.
    await railEntry(page, s.roomA).getByRole('button').click();
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${s.userA}:`,
      { timeout: 20_000 },
    );
    await expect(
      page.locator('trn-channel-sidebar .channel.channel--selected', {
        hasText: s.roomA,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // The open chat is never listed, and B's chat now names B, the account off screen.
    await expect(railEntry(page, s.roomA)).toHaveCount(0);
    await expect(
      railEntry(page, s.roomB).getByRole('button'),
    ).toHaveAccessibleName(`${s.roomB} · 1 unread · ${s.nameB}`);

    // Opening the chat sent its read receipt, so leaving it must not bring it back.
    await expect
      .poll(() => serverUnreadCount(request, hs, s.a, s.roomAId), {
        timeout: 20_000,
      })
      .toBe(0);
    await page
      .locator('trn-channel-sidebar .channel', { hasText: s.quietA })
      .click();
    await expect(
      page.locator('trn-channel-sidebar .channel.channel--selected', {
        hasText: s.quietA,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(railEntry(page, s.roomA)).toHaveCount(0);
    await expect(railEntry(page, s.roomB)).toBeVisible();

    // From the keyboard at desktop width: Enter opens the chat, and as its entry leaves the
    // rail focus moves into the conversation instead of falling to the page.
    await railEntry(page, s.roomB).getByRole('button').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.userbar__handle')).toContainText(
      `@${s.userB}:`,
      { timeout: 20_000 },
    );
    await expect(
      page.locator('trn-channel-sidebar .channel.channel--selected', {
        hasText: s.roomB,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(railEntry(page, s.roomB)).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return (
            !!active &&
            active !== document.body &&
            !!active.closest('main.main')
          );
        }),
      )
      .toBe(true);
  });

  test('Up to 5, All and Off choose how many unread chats the rail lists, and Off is saved and exported', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ru3`;
    const seeded = await seedUnreadRooms(request, hs, runId, 7);
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write']);

    await login(page, {
      available: true,
      hs,
      user: seeded.user,
      pass: seeded.pass,
    });

    // The default is "Up to 5": five chats, and a "+2" for the other two.
    await expect(railEntries(page)).toHaveCount(5, { timeout: 30_000 });
    await expect(overflowEntry(page)).toHaveText('+2');
    await expect(overflowEntry(page)).toHaveAccessibleName(
      '2 more unread chats in Recent activity',
    );
    for (const entry of await railEntryNames(page)) {
      expect(entry).toMatch(/^Unread \d\d .* · 1 unread$/);
    }

    // "+2" is a way to the rest: it shows Recent activity. Recent is the default view, so
    // step away to Rooms first to see the change.
    await page.getByTestId('rail-rooms').click();
    await expect(page.getByTestId('rail-rooms')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(page.getByTestId('rail-recent')).not.toHaveAttribute(
      'aria-current',
      'true',
    );
    await overflowEntry(page).click();
    await expect(page.getByTestId('rail-recent')).toHaveAttribute(
      'aria-current',
      'true',
    );

    // All: every chat, and nothing left over for "+N".
    await chooseRailUnreadChats(page, 'all');
    await expect(railEntries(page)).toHaveCount(7);
    await expect(overflowEntry(page)).toHaveCount(0);

    // Off: the section goes altogether.
    await page
      .getByRole('dialog', { name: 'Settings' })
      .getByTestId('space-rail-unread-chats-select')
      .locator('button')
      .click();
    await page.getByTestId('space-rail-unread-chats-off').click();
    await expect(railSection(page)).toHaveCount(0);
    await expect(railEntries(page)).toHaveCount(0);
    await expect(overflowEntry(page)).toHaveCount(0);

    // The choice is part of the exported settings, so it travels with a backup.
    await openSection(page, 'advanced');
    await page.getByTestId('advanced-copy').click();
    await expect(page.getByText('Settings copied.')).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const exported = JSON.parse(copied) as {
      settings?: { spaceRail?: { unreadChats?: string } };
    };
    expect(exported.settings?.spaceRail).toEqual({ unreadChats: 'off' });

    // The choice is saved on this device: it survives a reload.
    await page.reload();
    await waitForRooms(page);
    await expect(page.getByTestId('rail-rooms')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.locator('.channel', { hasText: seeded.rooms[0] }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(railSection(page)).toHaveCount(0);
    await openSettingsFromRooms(page);
    await openSection(page, 'appearance');
    await expect(
      page
        .getByRole('dialog', { name: 'Settings' })
        .getByTestId('space-rail-unread-chats-select')
        .locator('button'),
    ).toHaveText('Off');
  });

  test('Recent, Home and Rooms stay put while a long list of unread chats scrolls', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ru4`;
    // Twelve rooms are past Synapse's burst of ten joins, so seeding waits out the limit.
    test.setTimeout(240_000);
    const seeded = await seedUnreadRooms(request, hs, runId, 12);

    await login(page, {
      available: true,
      hs,
      user: seeded.user,
      pass: seeded.pass,
    });
    await expect(railEntries(page)).toHaveCount(5, { timeout: 30_000 });
    await chooseRailUnreadChats(page, 'all');
    await expect(railEntries(page)).toHaveCount(12);

    // Back to the list page of a phone: with no chat open the rail is on screen.
    await closeSettings(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const recent = page.getByTestId('rail-recent');
    const rooms = page.getByTestId('rail-rooms');
    const scroller = page.getByTestId('rail-scroll');
    await expect(recent).toBeVisible();
    await expect(rooms).toBeVisible();

    // The unread chats overflow the rail, so the scrolling group has something to scroll.
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(0);
    const recentBefore = await recent.boundingBox();
    const roomsBefore = await rooms.boundingBox();
    const firstBefore = await railEntries(page).first().boundingBox();
    expect(recentBefore && roomsBefore && firstBefore).toBeTruthy();

    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);

    // The entries moved; the pinned group did not.
    await expect
      .poll(async () => (await railEntries(page).first().boundingBox())?.y)
      .not.toBe(firstBefore!.y);
    expect(await recent.boundingBox()).toEqual(recentBefore);
    expect(await rooms.boundingBox()).toEqual(roomsBefore);
    await expect(recent).toBeInViewport();
  });
});
