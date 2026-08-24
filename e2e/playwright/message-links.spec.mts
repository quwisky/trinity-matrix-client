import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for matrix.to link navigation: a message linking to another room routes
// in-app (switches rooms) rather than leaving to matrix.to. Needs Synapse (Docker).
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

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

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('matrix.to link navigation', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('clicking a room permalink switches to that room in-app', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}l`;
    const hs = session.hs as string;
    const username = `link-user-${runId}`;
    const password = `${username}-pass`;
    await registerUser(request, username, password);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: username },
          password,
        },
      })
      .then((r) => r.json());
    const headers = { Authorization: `Bearer ${access_token}` };

    const sourceName = `Link Source ${runId}`;
    const targetName = `Link Target ${runId}`;
    const createRoom = (name: string) =>
      request
        .post(`${hs}/_matrix/client/v3/createRoom`, { headers, data: { name } })
        .then((r) => r.json())
        .then((j) => j.room_id as string);
    const sourceId = await createRoom(sourceName);
    const targetId = await createRoom(targetName);

    // A message in the source room linking to the target room.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(sourceId)}/send/m.room.message/link-${runId}`,
      {
        headers,
        data: {
          msgtype: 'm.text',
          body: `open ${targetName}`,
          format: 'org.matrix.custom.html',
          formatted_body: `open <a href="https://matrix.to/#/${targetId}">the target room</a>`,
        },
      },
    );

    await login(page, {
      available: true,
      hs,
      user: username,
      pass: password,
    } as SynapseSession);
    await openRoom(page, sourceName);

    // Click the in-message room link → the app switches to the target room.
    await page
      .locator('.scroll a', { hasText: 'the target room' })
      .first()
      .click();

    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      new RegExp(targetName),
      { timeout: 20_000 },
    );
  });

  test('clicking a mention shows a user card, not an empty room', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}u`;
    const hs = session.hs as string;
    const user = `mention-user-${runId}`;
    const pass = `${user}-pass`;
    const bob = `mention-bob-${runId}`;
    await registerUser(request, user, pass);
    await registerUser(request, bob, `${bob}-pass`);

    const token = (u: string, p: string) =>
      request
        .post(`${hs}/_matrix/client/v3/login`, {
          data: {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: u },
            password: p,
          },
        })
        .then((r) => r.json());
    const owner = await token(user, pass);
    const bobLogin = await token(bob, `${bob}-pass`);
    const bobId = bobLogin.user_id as string;
    const bobName = `Bobby${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(bobId)}/displayname`,
      {
        headers: { Authorization: `Bearer ${bobLogin.access_token}` },
        data: { displayname: bobName },
      },
    );

    const headers = { Authorization: `Bearer ${owner.access_token}` };
    const roomName = `Mention Room ${runId}`;
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    // A message mentioning Bob (a matrix.to user permalink, as a pill does).
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/mention-${runId}`,
      {
        headers,
        data: {
          msgtype: 'm.text',
          body: `hey ${bobName}`,
          format: 'org.matrix.custom.html',
          formatted_body: `hey <a href="https://matrix.to/#/${bobId}">${bobName}</a>`,
        },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // Clicking the mention opens a user card — it does not navigate anywhere.
    const mention = page.locator('.scroll a', { hasText: bobName }).first();
    const mentionBox = await mention.boundingBox();
    await mention.click();
    const card = page.getByTestId('user-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId('user-card-name')).toHaveText(bobName);

    // And it is a POPOVER pinned to that mention, not a modal centred over the room it
    // refers to. Two independent signals, because either alone can hold by accident: CDK
    // builds this wrapper only for a flexibly-connected overlay (a global centred strategy
    // has none), and the card hangs BELOW the mention it came from rather than at the
    // viewport's vertical middle.
    await expect(
      page.locator('.cdk-overlay-connected-position-bounding-box'),
    ).toBeVisible();
    const cardBox = await card.boundingBox();
    expect(mentionBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(cardBox!.y).toBeGreaterThanOrEqual(mentionBox!.y);
    expect(Math.abs(cardBox!.x - mentionBox!.x)).toBeLessThan(120);
    // Still in the same room (no empty room opened behind the card).
    await expect(page.getByTestId('composer-input')).toHaveAttribute(
      'placeholder',
      new RegExp(roomName),
    );
  });
});
