import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for @-mention autocomplete: typing `@` opens a member menu, picking one
// inserts a pill, and the sent message carries a matrix.to mention link (so it pings
// via m.mentions). Needs a Synapse homeserver (Docker).
const session = synapseSession();

async function apiToken(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<{ userId: string; headers: { Authorization: string } }> {
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

/** Register a reader plus a named member who joins the reader's room. */
async function seedRoomWithMember(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: SynapseSession;
  roomName: string;
  memberName: string;
  memberId: string;
}> {
  const readerUser = `mention-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  const memberUser = `mention-member-${runId}`;
  const memberPass = `${memberUser}-pass`;
  const memberName = `Bobby${runId}`;
  const roomName = `Mentions E2E ${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, memberUser, memberPass);
  const reader = await apiToken(request, hs, readerUser, readerPass);
  const member = await apiToken(request, hs, memberUser, memberPass);

  // A deterministic display name so the mention menu matches on it.
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(member.userId)}/displayname`,
    { headers: member.headers, data: { displayname: memberName } },
  );

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: roomName, invite: [member.userId] },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: member.headers },
  );

  return {
    reader: {
      available: true,
      hs,
      user: readerUser,
      pass: readerPass,
    },
    roomName,
    memberName,
    memberId: member.userId,
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

test.describe('Composer @-mentions', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('autocompletes a member and sends a pinging mention', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}m`;
    const { reader, roomName, memberName, memberId } = await seedRoomWithMember(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoom(page, roomName);

    // Type `@` + part of the member's name → the mention menu opens.
    const composer = page.getByTestId('composer-input');
    await composer.click();
    await composer.fill(`@${memberName.slice(0, 5)}`);
    const menu = page.getByTestId('mention-autocomplete');
    await expect(menu).toBeVisible({ timeout: 15_000 });
    await expect(menu.getByText(memberName)).toBeVisible();

    // Pick the member → the composer shows the mention, then send.
    await menu.getByText(memberName).click();
    await expect(composer).toHaveValue(`@${memberName} `);
    await composer.press('Enter');

    // The sent message renders the mention as a matrix.to link to the member,
    // i.e. it carries m.mentions and will ping them.
    const pill = page.locator(`.scroll a[href*="${memberId}"]`).first();
    await expect(pill).toBeVisible({ timeout: 20_000 });

    // ...and it READS as a mention rather than as a URL. The class is unit-tested; what
    // only a real browser can show is that the rule reached the bundle and matched — the
    // styles live in a global stylesheet, so a selector that never applies would leave the
    // class present and the pill looking exactly like an ordinary link.
    await expect(pill).toHaveClass(/\bmention\b/);

    // Polled rather than read once. The timeline can re-render between the class
    // assertion and this measurement, and getComputedStyle on a node that has just been
    // detached returns empty strings — so `Number(style.fontWeight)` comes back as 0 and
    // the spec reports "expected >= 600, received 0", which reads as the stylesheet
    // having failed to load rather than as a stale element handle.
    await expect
      .poll(
        () => pill.evaluate((el) => Number(getComputedStyle(el).fontWeight)),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(600);

    // Read once the weight above proves the element is attached and styled.
    const background = await pill.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const channels = background.match(/[\d.]+/g) ?? [];
    // An unstyled inline link is rgba(0, 0, 0, 0).
    expect(
      channels.length === 4 ? Number(channels[3]) > 0 : true,
      `background was ${background}`,
    ).toBe(true);
  });

  test('accepts a mention with the keyboard', async ({ page, request }) => {
    const runId = `${Date.now().toString(36)}k`;
    const { reader, roomName, memberName, memberId } = await seedRoomWithMember(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);
    await openRoom(page, roomName);

    const composer = page.getByTestId('composer-input');
    await composer.click();
    await composer.fill(`@${memberName.slice(0, 5)}`);
    await expect(page.getByTestId('mention-autocomplete')).toBeVisible({
      timeout: 15_000,
    });

    // Enter accepts the highlighted member; a second Enter sends the message.
    await composer.press('Enter');
    await expect(composer).toHaveValue(`@${memberName} `);
    await composer.press('Enter');

    await expect(
      page.locator(`.scroll a[href*="${memberId}"]`).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
