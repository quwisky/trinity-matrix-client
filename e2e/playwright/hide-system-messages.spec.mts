import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers issue #21: the Settings → Appearance toggles that hide system lines (joins,
// profile changes, room changes) from the timeline. Two users so a real
// "X joined the room" line exists, plus a message that must survive the filtering.
// Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
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

test.describe('Hide system messages', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('hiding joins removes the system line but keeps the messages', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sys`;
    const hostUser = `sys-host-${runId}`;
    const hostPass = `${hostUser}-pass`;
    const joinerUser = `sys-join-${runId}`;
    const joinerPass = `${joinerUser}-pass`;
    const roomName = `System ${runId}`;
    const joinerName = `Joiner ${runId}`;
    const body = `still here ${runId}`;

    await registerUser(request, hostUser, hostPass);
    await registerUser(request, joinerUser, joinerPass);
    const host = await apiLogin(request, hs, hostUser, hostPass);
    const joiner = await apiLogin(request, hs, joinerUser, joinerPass);

    // A distinctive display name so the join line is unambiguous in the timeline.
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(joiner.userId)}/displayname`,
      { headers: joiner.headers, data: { displayname: joinerName } },
    );
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: host.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [joiner.userId],
        },
      })
      .then((r) => r.json());
    // The join produces the "X joined the room" line this test is about…
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: joiner.headers },
    );
    // …and a message after it, which must survive the filtering. Sending is PUT with a
    // transaction id on the v3 API.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}`,
      { headers: joiner.headers, data: { msgtype: 'm.text', body } },
    );

    await login(page, {
      available: true,
      hs,
      user: hostUser,
      pass: hostPass,
    } as SynapseSession);
    await openRoom(page, roomName);

    // Everything is shown by default, so the join line is there to begin with.
    const joinLine = page.locator('[data-testid="timeline-event"]', {
      hasText: `${joinerName} joined the room`,
    });
    await expect(joinLine).toBeVisible({ timeout: 20_000 });
    // Scoped to the timeline row — the same text also appears in the channel-list preview.
    const message = page.locator('trn-message-row').filter({ hasText: body });
    await expect(message).toBeVisible();

    // Turn joins/leaves off in Settings → Appearance.
    await page.getByTestId('open-settings').click();
    await page.getByTestId('settings-nav-appearance').click();
    await page.waitForURL(/\/settings\/appearance$/, { timeout: 20_000 });
    const membershipToggle = page
      .getByTestId('timeline-show-membership')
      .locator('trn-checkbox');
    await expect(membershipToggle).toBeVisible({ timeout: 15_000 });
    await membershipToggle.click();

    await page.goto('/rooms');
    await openRoom(page, roomName);

    // The line is gone entirely, and the conversation around it is untouched.
    await expect(message).toBeVisible({ timeout: 20_000 });
    await expect(joinLine).toHaveCount(0);

    // And the choice survives a reload — it is persisted, not session state.
    await page.reload();
    await openRoom(page, roomName);
    await expect(message).toBeVisible({ timeout: 30_000 });
    await expect(joinLine).toHaveCount(0);
  });
});
