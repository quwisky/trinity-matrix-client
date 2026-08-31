import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

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

// A 1x1 transparent PNG — a valid image the homeserver accepts as an avatar.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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
 * Seed a reader with two rooms that differ ONLY in being a DM: a direct message with the
 * partner, and a named group room the same partner also joined. Both have no room avatar
 * and both therefore offer the SDK the same stand-in member — the two-person group room
 * is the case that regresses if the DM fallback is left to the SDK's member-count
 * heuristic, and a one-member room would not exercise that branch at all.
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

  const groupId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: groupName, invite: [partner.userId] },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  // Two members, exactly like the DM — and deliberately NOT recorded in `m.direct`.
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(groupId)}/join`,
    { headers: partner.headers },
  );

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
    const runId = `${testResourceId('run')}a`;
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

    // The control: a two-member NAMED group room, same partner, same picture, differing
    // only in not being in `m.direct`. It must keep its initial — dressing a room in a
    // member's face is worse than the initial it replaces, and it would vanish again the
    // moment a third person joined.
    //
    // Asserting an absence is only meaningful once the thing could have appeared, and
    // `toHaveCount(0)` is satisfied by the very first poll. The ordering above is what
    // makes it sound: the DM has already resolved this exact mxc at this exact size, so
    // it sits in AvatarService's cache, and a regressed build would replay it into the
    // group row synchronously rather than after a fetch.
    await page.getByTestId('rail-rooms').click();
    const groupRow = page.locator('.channel', { hasText: groupName });
    await groupRow.first().waitFor({ state: 'visible', timeout: 30_000 });
    await expect(groupRow.first().locator('trn-avatar')).toBeVisible();
    await expect(groupRow.first().locator('trn-avatar img')).toHaveCount(0);
  });
});
