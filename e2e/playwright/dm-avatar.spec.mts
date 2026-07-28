import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for the direct-message avatar. A DM is never given an `m.room.avatar`, so
// the room row has to fall back to the other person's picture; reading only the state
// event left every 1:1 conversation showing a coloured initial beside a name that had
// resolved to the person perfectly well.
//
// This is deliberately an e2e rather than only a unit test, because it is the one
// assertion in the suite that an avatar IMAGE actually reaches the screen. The `<img>`
// is projected by BrnAvatar only once its `load` event has fired, so requiring it to be
// visible exercises the whole chain: the SDK's heroes/member fallback, the projection,
// the authenticated-media fetch with a bearer token, the blob URL, and the decode.
// Needs a Synapse homeserver (Docker); self-skips otherwise like the other web specs.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

// A 1x1 transparent PNG — a valid image the homeserver accepts as an avatar.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

/** Register a user via Synapse's shared-secret admin endpoint (idempotent). */
async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const nonceRes = await request.get(
    `${SYNAPSE_HTTP}/_synapse/admin/v1/register`,
  );
  const { nonce } = await nonceRes.json();
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
  const res = await request.post(`${hs}/_matrix/client/v3/login`, {
    data: {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password: pass,
    },
  });
  const json = await res.json();
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/** Upload a PNG and set it as this user's profile picture. */
async function setProfileAvatar(
  request: APIRequestContext,
  hs: string,
  user: ApiUser,
): Promise<void> {
  const uploaded = await request
    .post(`${hs}/_matrix/media/v3/upload?filename=avatar.png`, {
      headers: { ...user.headers, 'Content-Type': 'image/png' },
      data: PNG_1x1,
    })
    .then((r) => r.json());
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(user.userId)}/avatar_url`,
    { headers: user.headers, data: { avatar_url: uploaded.content_uri } },
  );
}

/**
 * Seed a reader with two rooms: a DM whose partner has a profile picture but which has
 * no room avatar of its own, and a plain group room with no avatar at all — the control
 * that must keep showing its initial.
 */
async function seedDmAndGroup(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ reader: SynapseSession; groupName: string; partner: string }> {
  const readerUser = `dmav-reader-${runId}`;
  const readerPass = `dmav-reader-pass-${runId}`;
  const partnerUser = `dmav-partner-${runId}`;
  const partnerPass = `dmav-partner-pass-${runId}`;
  const groupName = `DM Avatar Control ${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, partnerUser, partnerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);
  const partner = await apiLogin(request, hs, partnerUser, partnerPass);

  // The partner's picture is on their PROFILE, never on the room — which is the whole
  // point: the room has nothing to read, so the fallback is the only way to find it.
  await setProfileAvatar(request, hs, partner);

  const dmId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: {
        preset: 'private_chat',
        invite: [partner.userId],
        is_direct: true,
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  // The partner must JOIN: their m.room.member event is what carries avatar_url into
  // the room, and it is what the heroes summary resolves against.
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(dmId)}/join`,
    { headers: partner.headers },
  );
  await request.put(
    `${hs}/_matrix/client/v3/user/${encodeURIComponent(reader.userId)}/account_data/m.direct`,
    { headers: reader.headers, data: { [partner.userId]: [dmId] } },
  );

  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: reader.headers,
    data: { name: groupName },
  });

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    groupName,
    partner: partnerUser,
  };
}

test.describe('Direct-message avatar', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test("a DM row shows the other person's picture, not an initial", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}a`;
    const { reader, groupName, partner } = await seedDmAndGroup(
      request,
      session.hs as string,
      runId,
    );

    await login(page, reader);

    // The default Home view lists direct messages.
    const dmRow = page.locator('.channel', { hasText: partner });
    await dmRow.first().waitFor({ state: 'visible', timeout: 30_000 });

    // BrnAvatar only projects the <img> once it has actually loaded, so this is an
    // assertion about pixels reaching the screen, not merely about a bound attribute.
    const dmImage = dmRow.first().locator('trn-avatar img');
    await expect(dmImage).toBeVisible({ timeout: 30_000 });
    await expect(dmImage).toHaveAttribute('src', /^blob:/);

    // The control: a group room with no avatar has no stand-in member and correctly
    // keeps its coloured initial. Without it, a selector that matched anything at all
    // would let this test pass while the fallback did nothing.
    await page.getByTestId('rail-rooms').click();
    const groupRow = page.locator('.channel', { hasText: groupName });
    await groupRow.first().waitFor({ state: 'visible', timeout: 30_000 });
    await expect(groupRow.first().locator('trn-avatar img')).toHaveCount(0);
  });
});
