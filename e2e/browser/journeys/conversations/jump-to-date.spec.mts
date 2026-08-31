import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers "Jump to date" (room ⋯ → overflow-jump-to-date): a date picker resolves a day to
// an event via /timestamp_to_event (MSC3030), and the timeline pages history back until
// that event is loaded and scrolls to it.
//
// The backfill is the point. The server answers for the whole room and names an event this
// client has never loaded; the list scrolls by DOM lookup, so without paging it in the jump
// is a silent no-op. The fixture therefore seeds MORE messages than the initial window, so
// the target genuinely is not loaded when the jump starts — a shorter room would pass
// whether or not the loop exists.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

/** `YYYY-MM-DD` in the browser's local zone, which is what the date input expects. */
function isoToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

test.describe('Jump to date', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('pages history back to reach a message that was not loaded', async ({
    page,
    request,
  }) => {
    test.slow(); // seeds ~120 messages over the API

    const hs = session.hs as string;
    const runId = `${testResourceId('run')}j`;
    const user = `jump-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Jump ${runId}`;
    const marker = `first-of-the-day ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const headers = { Authorization: `Bearer ${token}` };
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    // The marker goes FIRST, then enough traffic to push it well outside the initial
    // window, so reaching it requires the backfill loop rather than luck.
    const send = (body: string, txn: string) =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${txn}`,
        { headers, data: { msgtype: 'm.text', body } },
      );
    await send(marker, `${runId}-marker`);
    // In batches rather than one at a time: 120 sequential round trips took minutes and
    // dominated the whole suite. Ordering among the fillers does not matter — only that
    // every one of them lands after the marker, which the await above guarantees.
    for (let batch = 0; batch < 120; batch += 20) {
      await Promise.all(
        Array.from({ length: 20 }, (_, n) =>
          send(`filler ${batch + n} ${runId}`, `${runId}-f${batch + n}`),
        ),
      );
    }

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // The newest messages are on screen; the marker is not.
    await expect(
      page.locator('.scroll .msg', { hasText: `filler 119 ${runId}` }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.scroll .msg', { hasText: marker })).toHaveCount(
      0,
    );

    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-jump-to-date').click();

    // Everything was sent today, so today's midnight resolves to the marker — the first
    // message on or after it.
    const input = page.getByTestId('jump-to-date-input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill(isoToday());
    await page.getByTestId('jump-to-date-confirm').click();

    // The marker is now rendered, which can only happen if the loop paged it in.
    await expect(
      page.locator('.scroll .msg', { hasText: marker }).first(),
    ).toBeVisible({ timeout: 60_000 });
  });

  test('reports a date with nothing on it instead of jumping', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}jn`;
    const user = `jumpn-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Jump none ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-jump-to-date').click();

    // A date well after the room's last event: the room was created today, so tomorrow
    // has nothing on or after it. (The input caps at today, so drive the value directly —
    // this is about the service's answer, not the control's bounds.)
    const input = page.getByTestId('jump-to-date-input');
    await expect(input).toBeVisible({ timeout: 10_000 });
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    await input.evaluate(
      (el, value) => {
        const field = el as HTMLInputElement;
        field.removeAttribute('max');
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      },
      `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`,
    );
    await page.getByTestId('jump-to-date-confirm').click();

    // Says so, rather than appearing to work.
    await expect(page.getByText(/No messages on or after/i)).toBeVisible({
      timeout: 30_000,
    });
  });
});
