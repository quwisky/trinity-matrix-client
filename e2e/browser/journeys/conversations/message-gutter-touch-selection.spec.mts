import { devices, expect, test, testResourceId } from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

const session = synapseSession();

test.use({ ...devices['Pixel 5'] });

test.describe('Grouped message timestamp on a touch device', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('marks the hover-only timestamp nonselectable without hiding the message body', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = testResourceId('gutter');
    const user = `gutter-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Gutter ${runId}`;
    const secondBody = `Second grouped message ${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((response) => response.json());
    const headers = { Authorization: `Bearer ${access_token}` };
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((response) => response.json());

    for (const [index, body] of [
      'First grouped message',
      secondBody,
    ].entries()) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-${index}`,
        { headers, data: { msgtype: 'm.text', body } },
      );
    }

    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName }).first();
    await expect(channel).toBeVisible({ timeout: 30_000 });
    await channel.click();

    const row = page.locator('.msg--cont', { hasText: secondBody });
    await expect(row).toBeVisible({ timeout: 30_000 });
    const styles = await row.evaluate((element) => {
      const gutter = element.querySelector<HTMLElement>('.msg__gutter');
      const body = element.querySelector<HTMLElement>('.msg__text');
      if (!gutter || !body) throw new Error('grouped row is incomplete');
      return {
        noHover: matchMedia('(hover: none)').matches,
        gutterUserSelect: getComputedStyle(gutter).userSelect,
        bodyUserSelect: getComputedStyle(body).userSelect,
        gutterVisibility: getComputedStyle(gutter).visibility,
        gutterWidth: gutter.getBoundingClientRect().width,
        hasTimestamp: Boolean(gutter.textContent?.trim()),
      };
    });

    expect(styles.noHover).toBe(true);
    expect(styles.gutterUserSelect).toBe('none');
    expect(styles.bodyUserSelect).not.toBe('none');
    expect(styles.gutterVisibility).toBe('visible');
    expect(styles.gutterWidth).toBe(40);
    expect(styles.hasTimestamp).toBe(true);
  });
});
