import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { login, synapseSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { openSettingsSection } from '../../../support/journeys/navigation.mts';

// Covers issue #22: the Settings → Appearance dropdowns that choose how times and dates are
// written. The unit tests cover the formatting itself; what only a real browser can prove is
// the CDK-overlay round-trip (open the dropdown, pick an option) and that the choice reaches
// an already-rendered timeline and survives a reload.
// Needs a Synapse homeserver (Docker); self-skips.
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

/**
 * Pick an option from one of the format dropdowns.
 *
 * The option list lives in a CDK overlay that only exists while the trigger is open — which
 * is precisely why this lives in e2e rather than in the component spec.
 */
async function chooseFormat(
  page: Page,
  select: string,
  option: string,
): Promise<void> {
  await page.getByTestId(select).locator('button').first().click();
  const item = page.getByTestId(option);
  await item.waitFor({ state: 'visible', timeout: 15_000 });
  await item.click();
  await expect(item).toHaveCount(0); // the overlay closed
}

/** The timestamp on the first message row in the open room. */
function firstTimestamp(page: Page) {
  return page.locator('trn-message-row .msg__time').first();
}

test.describe('Date and time format', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a 24-hour clock and an ISO date reach the timeline and survive a reload', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}fmt`;
    const user = `fmt-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Format ${runId}`;
    const body = `timestamped ${runId}`;

    await registerUser(request, user, pass);
    const me = await apiLogin(request, hs, user, pass);
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: me.headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}`,
      { headers: me.headers, data: { msgtype: 'm.text', body } },
    );

    await login(page, { available: true, hs, user, pass });
    await openRoom(page, roomName);
    await expect(firstTimestamp(page)).toBeVisible({ timeout: 20_000 });

    // Settings → Appearance → both dropdowns.
    await openSettingsSection(page, 'appearance');
    await chooseFormat(page, 'time-format-select', 'time-format-h24');
    await chooseFormat(page, 'date-format-select', 'date-format-iso');

    // #168: what each CLOSED dropdown then reads. This suite addresses options by
    // data-testid and never looked at the trigger, which is how it stayed green while the
    // trigger showed the stored id — `h24`, `iso` — instead of the option just clicked.
    await expect(
      page.getByTestId('time-format-select').locator('button').first(),
    ).toContainText('24-hour');
    await expect(
      page.getByTestId('date-format-select').locator('button').first(),
    ).toContainText('ISO');

    // The sample line reflects both choices immediately, with no reload.
    await expect(page.getByTestId('date-time-showing')).toContainText(
      '2026-07-24, 15:45',
    );

    // …and so does the timeline behind it: an ISO date and a 24-hour clock, no AM/PM.
    await page.goto('/rooms');
    await openRoom(page, roomName);
    await expect(firstTimestamp(page)).toHaveText(
      /^\d{4}-\d{2}-\d{2}, \d{2}:\d{2}$/,
      {
        timeout: 20_000,
      },
    );
    await expect(firstTimestamp(page)).not.toContainText(/AM|PM/);

    // The choice is persisted, not session state.
    await page.reload();
    await openRoom(page, roomName);
    await expect(firstTimestamp(page)).toHaveText(
      /^\d{4}-\d{2}-\d{2}, \d{2}:\d{2}$/,
      {
        timeout: 20_000,
      },
    );
  });
});
