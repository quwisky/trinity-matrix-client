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

// Covers the "seen by" reader list: clicking a message's read-receipt cluster
// (data-testid="read-receipts") expands the names of who read it (seen-by-list).
// Another user reads the message (via the receipts API) so a receipt appears.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
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

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Seen by', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('expands who read a message from its receipt cluster', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sb`;
    const me = `sb-me-${runId}`;
    const mePass = `${me}-pass`;
    const reader = `sb-reader-${runId}`;
    const readerPass = `${reader}-pass`;
    const readerName = `Reader ${runId}`;
    const roomName = `Seen ${runId}`;
    const body = `did you read this ${runId}`;

    await registerUser(request, me, mePass);
    await registerUser(request, reader, readerPass);
    const author = await apiLogin(request, hs, me, mePass);
    const other = await apiLogin(request, hs, reader, readerPass);

    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(other.userId)}/displayname`,
      { headers: other.headers, data: { displayname: readerName } },
    );
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: author.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [other.userId],
        },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: other.headers },
    );

    await login(page, {
      available: true,
      hs,
      user: me,
      pass: mePass,
    } as SynapseSession);
    await openRoom(page, roomName);

    const composer = page.getByTestId('composer-input');
    await composer.fill(body);
    await composer.press('Enter');
    await expect(
      page.locator('.scroll .msg', { hasText: body }).first(),
    ).toBeVisible({
      timeout: 20_000,
    });

    // Find the message's event id, then have the reader mark it read.
    const findEventId = async (): Promise<string | null> => {
      const res = await request.get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/messages?dir=b&limit=10`,
        { headers: author.headers },
      );
      const chunk: {
        type: string;
        content?: { body?: string };
        event_id: string;
      }[] = res.ok() ? (await res.json()).chunk : [];
      return (
        chunk.find(
          (e) => e.type === 'm.room.message' && e.content?.body === body,
        )?.event_id ?? null
      );
    };
    let eventId = '';
    await expect
      .poll(async () => (eventId = (await findEventId()) ?? ''))
      .not.toBe('');
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      { headers: other.headers, data: {} },
    );

    // The read-receipt cluster appears; clicking it reveals who read.
    const cluster = page.getByTestId('read-receipts').first();
    await expect(cluster).toBeVisible({ timeout: 20_000 });
    await cluster.click();
    await expect(page.getByTestId('seen-by-list').first()).toContainText(
      readerName,
      { timeout: 10_000 },
    );
  });
});
