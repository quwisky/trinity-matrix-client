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
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// Covers the "Send read receipts" privacy toggle (Settings → Privacy). With it
// OFF, reading a message must still clear the reader's own unread state — but
// privately (`m.read.private`), so the sender never sees a public `m.read`
// receipt from them. Two users: the sender posts, the reader (toggle off) reads,
// and we check what each side's sync reports. Needs Synapse (Docker); self-skips.
const session = synapseSession();

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

/** The `m.receipt` ephemeral content for a room from a fresh (initial) sync. */
async function roomReceipts(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
  roomId: string,
): Promise<Record<string, Record<string, Record<string, unknown>>>> {
  const sync = await request
    .get(`${hs}/_matrix/client/v3/sync?timeout=0`, { headers: user.headers })
    .then((r) => r.json());
  const events = sync?.rooms?.join?.[roomId]?.ephemeral?.events ?? [];
  const receipt = events.find(
    (e: { type: string }) => e.type === 'm.receipt',
  ) as { content?: Record<string, Record<string, Record<string, unknown>>> };
  return receipt?.content ?? {};
}

/** Whether the room carries a receipt of `receiptType` from `userId` on any event. */
function hasReceiptFrom(
  content: Record<string, Record<string, Record<string, unknown>>>,
  receiptType: string,
  userId: string,
): boolean {
  return Object.values(content).some(
    (byType) => byType?.[receiptType]?.[userId] !== undefined,
  );
}

/** From /rooms, open the named room and wait for its composer. */
async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Read-receipt privacy', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('with the toggle off, reading acks privately and hides it from the sender', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}rr`;
    const readerUser = `rr-reader-${runId}`;
    const readerPass = `${readerUser}-pass`;
    const senderUser = `rr-sender-${runId}`;
    const senderPass = `${senderUser}-pass`;
    const roomName = `Receipts ${runId}`;

    await registerUser(request, readerUser, readerPass);
    await registerUser(request, senderUser, senderPass);
    const reader = await apiLogin(request, hs, readerUser, readerPass);
    const sender = await apiLogin(request, hs, senderUser, senderPass);

    // Sender creates the room, invites the reader, who joins; sender then posts.
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: sender.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [reader.userId],
        },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: reader.headers },
    );
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-msg`,
      {
        headers: sender.headers,
        data: { msgtype: 'm.text', body: 'Did you read this?' },
      },
    );

    // Reader signs in and turns OFF "Send read receipts" BEFORE opening the room.
    await login(page, {
      available: true,
      hs,
      user: readerUser,
      pass: readerPass,
    } as SynapseSession);
    await openSettingsSection(page, 'privacy');
    const toggle = page
      .getByTestId('privacy-send-read-receipts')
      .locator('trn-switch');
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    await toggle.click();

    // Now open the room — reading it acks the message (privately). Scope to the
    // timeline message row: the same text also appears in the channel-list preview
    // (`.channel__preview`), so a bare getByText matches two elements.
    await page.goto('/rooms');
    await openRoom(page, roomName);
    await expect(
      page.locator('trn-message-row').filter({ hasText: 'Did you read this?' }),
    ).toBeVisible({
      timeout: 20_000,
    });

    // The reader's own view confirms a PRIVATE ack landed (so the read happened)…
    await expect
      .poll(
        async () =>
          hasReceiptFrom(
            await roomReceipts(request, hs, reader, room_id),
            'm.read.private',
            reader.userId,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);

    // …while the sender never sees a PUBLIC read receipt from the reader.
    const senderView = await roomReceipts(request, hs, sender, room_id);
    expect(hasReceiptFrom(senderView, 'm.read', reader.userId)).toBe(false);
  });
});
