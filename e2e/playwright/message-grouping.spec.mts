import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the Discord-style grouping of consecutive messages from one sender: the
// follow-on rows drop the avatar for a hover-only timestamp gutter, which must measure
// exactly as wide as the avatar it replaces (40px) or every grouped message lands out
// of line with the first.
//
// This can only be caught in a real browser — the regression was a *layout* one (a flex
// item's automatic minimum size overriding its declared basis), and jsdom does no
// layout, so a component spec cannot see it. Needs Synapse (Docker).
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

/** The avatar size a header row reserves; the grouped gutter must match it. */
const LEAD_WIDTH = 40;

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

test.describe('Message grouping', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('grouped messages line up with the first of their group', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}mg`;
    const me = `mg-me-${runId}`;
    const mePass = `${me}-pass`;
    const roomName = `Grouping ${runId}`;
    const bodies = ['First message', 'Second message', 'Third message'];

    await registerUser(request, me, mePass);
    const author = await apiLogin(request, hs, me, mePass);

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: author.headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());

    // Same sender, back to back: rows 2 and 3 group under row 1's header.
    for (const [i, body] of bodies.entries()) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-${i}`,
        { headers: author.headers, data: { msgtype: 'm.text', body } },
      );
    }

    await login(page, {
      available: true,
      hs,
      user: me,
      pass: mePass,
    } as SynapseSession);
    // A named, non-DM room is listed under the Rooms view rather than Home's DMs.
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName }).first();
    await expect(channel).toBeVisible({ timeout: 30_000 });
    await channel.click();

    for (const body of bodies) {
      await expect(page.locator('.msg__text', { hasText: body })).toBeVisible({
        timeout: 30_000,
      });
    }

    // Exactly one header row, and the other two grouped under it.
    await expect(page.locator('.msg .msg__avatar')).toHaveCount(1);
    await expect(page.locator('.msg--cont')).toHaveCount(bodies.length - 1);

    // The invariant: the gutter standing in for the avatar is the same width, so the
    // bodies share a left edge. Measured, not asserted from the stylesheet — the bug
    // was the used width silently exceeding the declared one.
    const lead = await page.evaluate(() =>
      [...document.querySelectorAll('.msg')]
        .filter((row) => row.querySelector('.msg__text'))
        .map((row) => {
          const el = row.querySelector('.msg__avatar, .msg__gutter');
          return el ? el.getBoundingClientRect().width : null;
        }),
    );
    expect(lead).toEqual(bodies.map(() => LEAD_WIDTH));

    const textLeft = await page.evaluate(() =>
      [...document.querySelectorAll('.msg__text')].map(
        (el) => el.getBoundingClientRect().left,
      ),
    );
    expect(textLeft).toHaveLength(bodies.length);
    for (const left of textLeft) {
      expect(left).toBeCloseTo(textLeft[0], 1);
    }
  });
});
