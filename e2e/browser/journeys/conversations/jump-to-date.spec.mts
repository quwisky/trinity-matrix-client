import { testResourceId, test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers "Jump to date" (room ⋯ → overflow-jump-to-date) when the chosen day has nothing
// on or after it: /timestamp_to_event (MSC3030) finds no event, and the dialog says so
// instead of appearing to jump. The backfill jump itself runs natively as
// android.jump-to-date (#737).
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

test.describe('Jump to date', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

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
