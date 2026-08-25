import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for typing indicators: when another member of the open room starts
// typing, the app shows an "X is typing…" row under the timeline, and clears it once
// they stop. The other member's typing is driven straight through the Matrix API, so
// this exercises our sync → signal → render path. Needs a Synapse homeserver (Docker).
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
  roomId: string;
  memberName: string;
  memberId: string;
  memberHeaders: { Authorization: string };
}> {
  const readerUser = `typing-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  const memberUser = `typing-member-${runId}`;
  const memberPass = `${memberUser}-pass`;
  const memberName = `Tilly${runId}`;
  const roomName = `Typing E2E ${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, memberUser, memberPass);
  const reader = await apiToken(request, hs, readerUser, readerPass);
  const member = await apiToken(request, hs, memberUser, memberPass);

  // A deterministic display name so the typing row is easy to assert on.
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
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
    roomId,
    memberName,
    memberId: member.userId,
    memberHeaders: member.headers,
  };
}

/** Drive the other member's typing state straight through the Matrix API. */
async function setMemberTyping(
  request: APIRequestContext,
  hs: string,
  roomId: string,
  member: { userId: string; headers: { Authorization: string } },
  typing: boolean,
): Promise<void> {
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(member.userId)}`,
    {
      headers: member.headers,
      data: typing ? { typing: true, timeout: 30_000 } : { typing: false },
    },
  );
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

test.describe('Typing indicators', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test("shows and clears another member's typing", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}t`;
    const hs = session.hs as string;
    const { reader, roomName, roomId, memberName, memberId, memberHeaders } =
      await seedRoomWithMember(request, hs, runId);
    const member = { userId: memberId, headers: memberHeaders };

    await login(page, reader);
    await openRoom(page, roomName);

    const indicator = page.getByTestId('typing-indicator');

    // The other member starts typing → the row appears naming them.
    await setMemberTyping(request, hs, roomId, member, true);
    await expect(indicator).toBeVisible({ timeout: 20_000 });
    await expect(indicator).toHaveText(`${memberName} is typing…`);

    // …and stops → the row goes away.
    await setMemberTyping(request, hs, roomId, member, false);
    await expect(indicator).toBeHidden({ timeout: 20_000 });
  });
});
