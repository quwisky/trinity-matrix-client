import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../fixtures.mts';
import { login, synapseSession, type SynapseSession } from '../support/app.mts';
import { registerUser } from '../support/account.mts';
import { openSettingsSection } from '../support/journeys/navigation.mts';

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

/** A word no other rule could match, so the highlight can only come from our keyword. */
const KEYWORD = 'zarquon';

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
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
    const runId = `${testResourceId('run')}k`;
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
    await openSettingsSection(page, 'notifications');

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

    // The Sound checkbox round-trips too: unticking it rewrites the rule's actions on
    // the server, and the highlight tweak survives (a keyword that notifies without
    // marking where it matched is a notification you cannot act on).
    const hasTweak = (
      rule: { actions: unknown[] } | undefined,
      tweak: string,
    ) =>
      (rule?.actions ?? []).some(
        (action) =>
          !!action &&
          typeof action === 'object' &&
          (action as { set_tweak?: string }).set_tweak === tweak,
      );
    expect(hasTweak(rule, 'sound')).toBe(true);
    await page.getByTestId('keyword-sound').first().locator('button').click();
    await expect
      .poll(async () => hasTweak(await contentRule(), 'sound'), {
        timeout: 20_000,
      })
      .toBe(false);
    expect(hasTweak(await contentRule(), 'highlight')).toBe(true);

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

    // Removing it deletes the rule server-side rather than only dropping the row — the
    // rule is addressed by id, and a delete aimed at the wrong string simply 404s.
    await page.goto('/settings/notifications');
    await expect(page.getByTestId('keyword-row')).toHaveCount(1);
    await page.getByTestId('keyword-remove').first().click();
    await expect.poll(contentRule, { timeout: 20_000 }).toBeUndefined();
    await expect(page.getByTestId('keyword-row')).toHaveCount(0);
    await expect(page.getByTestId('keyword-empty')).toBeVisible();
  });

  test('a muted room stays muted, exactly as the settings copy promises', async ({
    page,
    request,
  }) => {
    // The Keywords block tells the user "A muted room stays muted — keywords do not
    // override it." That is a claim about the homeserver's own rule ordering (content
    // rules sit below overrides), and nothing verified it. Muting through the room menu
    // rather than the API keeps RoomNotificationsService in the loop, so writing the mute
    // as the wrong rule kind fails here too.
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}m`;
    const readerUser = `kwm-reader-${runId}`;
    const readerPass = `${readerUser}-pass`;
    const senderUser = `kwm-sender-${runId}`;
    const senderPass = `${senderUser}-pass`;
    const roomName = `Keyword Mute E2E ${runId}`;

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

    await login(page, {
      available: true,
      hs,
      user: readerUser,
      pass: readerPass,
    } as SynapseSession);
    await openSettingsSection(page, 'notifications');
    const input = page.getByTestId('keyword-input');
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill(KEYWORD);
    await page.getByTestId('keyword-add').click();
    await expect(page.getByTestId('keyword-row')).toHaveCount(1);

    // Mute the room through its own ⋮ menu, which is what a user would do.
    await page.goto('/rooms');
    await page.getByTestId('rail-rooms').click();
    const row = page.locator('.channel-row', { hasText: roomName }).first();
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    await row.hover();
    await row.getByRole('button', { name: `Options for ${roomName}` }).click();
    await page.getByTestId('room-notify').click();
    await expect(page.getByTestId('room-notify-mute')).toBeVisible({
      timeout: 10_000,
    });
    await Promise.all([
      page.waitForResponse(
        (r) =>
          /\/pushrules\/?$/.test(new URL(r.url()).pathname) &&
          r.request().method() === 'GET',
        { timeout: 15_000 },
      ),
      page.getByTestId('room-notify-mute').click(),
    ]);

    const sent = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/kwm-${runId}`,
      {
        headers: sender.headers,
        data: { msgtype: 'm.text', body: `still saying ${KEYWORD} in here` },
      },
    );
    expect(sent.ok()).toBe(true);

    // The control that makes the absence meaningful: the message DID arrive, so a
    // missing highlight is the mute winning rather than nothing having happened.
    const channel = page.locator('.channel', { hasText: roomName }).first();
    // `:not(...--typing)`: the preview line now swaps to "X is typing" while anybody in
    // the room is typing, so an unscoped locator can catch the transient text instead of
    // the message and fail against correct code.
    await expect(
      channel.locator('.channel__preview:not(.channel__preview--typing)'),
    ).toContainText(KEYWORD, { timeout: 30_000 });
    await expect(
      channel.locator('.channel__badge:not(.channel__badge--muted)'),
    ).toHaveCount(0);
  });
});
