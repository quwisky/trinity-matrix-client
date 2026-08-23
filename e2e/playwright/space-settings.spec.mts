import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers editing a SPACE's settings, which had no surface at all before #40: a space was
// configured once at creation and never again. The space overflow menu
// (data-testid="space-actions-overflow") gains a "Space settings" row
// (data-testid="open-space-settings") opening a dialog (data-testid="space-settings") with
// Name/Topic/join-rule fields — trigger and dialog named apart, as the room pair is.
//
// Asserted server-side via the CS API rather than on the dialog closing: a settings dialog
// that closes having written nothing looks identical from the UI, and that is exactly the
// failure this spec exists to catch.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
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

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return json.access_token as string;
}

/**
 * Create a space (a room with `creation_content.type: m.space`, matching
 * `SpacesService.createSpace`) as the signed-in user, who is therefore its admin.
 */
async function createSpace(
  request: APIRequestContext,
  hs: string,
  token: string,
  name: string,
): Promise<string> {
  const res = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name,
      preset: 'private_chat',
      creation_content: { type: 'm.space' },
    },
  });
  if (!res.ok()) {
    throw new Error(`createRoom(space) → ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).room_id as string;
}

/**
 * Select the space's rail pill and open its ⋮ overflow. `ServerRailComponent` puts no
 * testid on the pill — it is an `aria-label`ed button named after the space (see
 * room-filter-spaceless.spec.mts, which relies on the same thing).
 */
async function openSpaceMenu(page: Page, spaceName: string): Promise<void> {
  const pill = page.getByRole('button', { name: spaceName, exact: true });
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  await pill.click();
  await page.getByTestId('space-actions-overflow').click();
}

/** Read one field out of a room's current state, or undefined if it isn't set. */
async function stateValue(
  request: APIRequestContext,
  hs: string,
  token: string,
  roomId: string,
  type: string,
  key: string,
): Promise<unknown> {
  const res = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return res.ok() ? (await res.json())[key] : undefined;
}

/** Invite `userId` into `spaceId` and accept as that user, so they are a plain member. */
async function joinAsMember(
  request: APIRequestContext,
  hs: string,
  ownerToken: string,
  spaceId: string,
  memberToken: string,
  memberId: string,
): Promise<void> {
  const invite = await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/invite`,
    {
      headers: { Authorization: `Bearer ${ownerToken}` },
      data: { user_id: memberId },
    },
  );
  if (!invite.ok()) {
    throw new Error(`invite → ${invite.status()} ${await invite.text()}`);
  }
  const join = await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/join`,
    { headers: { Authorization: `Bearer ${memberToken}` } },
  );
  if (!join.ok()) {
    throw new Error(`join → ${join.status()} ${await join.text()}`);
  }
}

test.describe('Space settings', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('an admin renames a space, sets its topic and publishes it', async ({
    page,
    request,
  }) => {
    // Three state events round-tripping through /sync, which is slow under full-suite load.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sp`;
    const user = `space-settings-${runId}`;
    const pass = `${user}-pass`;
    const originalName = `Team ${runId}`;
    const newName = `Renamed ${runId}`;
    const newTopic = `Where team ${runId} works`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, originalName);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceMenu(page, originalName);

    await page.getByTestId('open-space-settings').click();
    await expect(page.getByTestId('space-settings-name')).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('space-settings-name').fill(newName);
    await page.getByTestId('space-settings-topic').fill(newTopic);
    // `selectOption` only ever drove a native `<select>`; this is a `trn-select` now, whose
    // options live in a CDK portal.
    await page.getByTestId('space-settings-join-rule').click();
    await page.getByTestId('join-rule-public').click();
    await page.getByTestId('space-settings-save').click();

    const read = (type: string, key: string) =>
      stateValue(request, hs, token, spaceId, type, key);

    await expect
      .poll(() => read('m.room.name', 'name'), { timeout: 30_000 })
      .toBe(newName);
    await expect
      .poll(() => read('m.room.topic', 'topic'), { timeout: 30_000 })
      .toBe(newTopic);
    await expect
      .poll(() => read('m.room.join_rules', 'join_rule'), { timeout: 30_000 })
      .toBe('public');

    // Deliberately NOT asserting that the rail pill re-labels itself. A rename is an
    // m.room.name state event with no local echo, so the client only sees it once /sync
    // returns it — and that took over 90s on one run here, leaving the pill, the sidebar
    // title and the overflow's own label all reading the old name together (i.e. the SDK's
    // Room.name was stale, not Trinity's projection of it). room-settings.spec.mts covers
    // rename-then-re-label for rooms and documents the same latency; repeating it here
    // buys nothing but a flake.
  });

  test('the dialog seeds from the space’s current values', async ({
    page,
    request,
  }) => {
    // A dialog that opened blank would still save correctly in the test above (every field
    // is "changed" from empty), so seeding needs its own assertion — and the name has to
    // come from m.room.name, not the SDK's fabricated display name.
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sd`;
    const user = `space-seed-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Seeded ${runId}`;
    const topic = `Topic ${runId}`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, spaceName);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.topic/`,
      { headers: { Authorization: `Bearer ${token}` }, data: { topic } },
    );
    // Deliberately NOT the invite-only rule `preset: private_chat` created: the form model
    // seeds `joinRule: JoinRule.Invite` itself, so asserting "invite" proved nothing — a
    // dialog that read the rule off nothing at all would have passed. Open the space up
    // first, and the assertion below can only hold if the dialog read the real state event.
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.join_rules/`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { join_rule: 'public' },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-settings').click();

    await expect(page.getByTestId('space-settings-name')).toHaveValue(
      spaceName,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId('space-settings-topic')).toHaveValue(topic);
    // A `trn-select` collapsed trigger renders the chosen option's LABEL, not its value —
    // there is no form control to call `toHaveValue` on any more.
    await expect(page.getByTestId('space-settings-join-rule')).toHaveText(
      /Anyone can find and join/,
      { timeout: 10_000 },
    );
  });

  test('a member without permission sees the fields but cannot edit them', async ({
    page,
    request,
  }) => {
    // The dialog is seeded per-field from the viewer's power level. Proving that reaches
    // the UI matters more for a space than a room: a space is where "who can administer
    // this" is least obvious, and a form that looked editable and then failed on Save
    // would be indistinguishable from a broken write.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ro`;
    const owner = `space-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const member = `space-member-${runId}`;
    const memberPass = `${member}-pass`;
    const spaceName = `ReadOnly ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, member, memberPass);
    const ownerToken = await apiLogin(request, hs, owner, ownerPass);
    const memberLogin = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: member },
          password: memberPass,
        },
      })
      .then((r) => r.json());
    const spaceId = await createSpace(request, hs, ownerToken, spaceName);
    await joinAsMember(
      request,
      hs,
      ownerToken,
      spaceId,
      memberLogin.access_token as string,
      memberLogin.user_id as string,
    );

    await login(page, {
      available: true,
      hs,
      user: member,
      pass: memberPass,
    } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-settings').click();

    // Shown, so the member can still READ the space's settings — but not writable.
    await expect(page.getByTestId('space-settings-name')).toHaveValue(
      spaceName,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId('space-settings-name')).toBeDisabled();
    await expect(page.getByTestId('space-settings-topic')).toBeDisabled();
    await expect(page.getByTestId('space-settings-join-rule')).toBeDisabled();
    await expect(page.getByTestId('space-settings-save')).toBeDisabled();
  });

  test('an admin publishes an address for the space', async ({
    page,
    request,
  }) => {
    // The space dialog embeds the same addresses section as the room one. It is also the
    // only e2e that drives that input inside the SPACE form, where a bare Enter used to
    // submit the dialog and close it instead of adding the address.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sa`;
    const user = `space-addr-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Addressed ${runId}`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createSpace(request, hs, token, spaceName);
    const localpart = `space-addr-${runId}`;
    const alias = `#${localpart}:localhost`;

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    await page.getByTestId('open-space-settings').click();
    await expect(page.getByTestId('room-aliases')).toBeVisible({
      timeout: 10_000,
    });

    // Enter, deliberately — not the Add button. This is the path that used to save and
    // close the dialog via implicit form submission.
    await page.getByTestId('room-alias-input').fill(localpart);
    await page.getByTestId('room-alias-input').press('Enter');

    // The dialog is still open (Enter must not have submitted it) and the address is live.
    await expect(page.getByTestId('space-settings-name')).toBeVisible();
    await expect(
      page.getByTestId('room-alias').filter({ hasText: alias }),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `${hs}/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
          );
          return res.ok() ? (await res.json()).room_id : undefined;
        },
        { timeout: 20_000 },
      )
      .toBe(spaceId);
  });

  test('the space members dialog names the space creator the owner', async ({
    page,
    request,
  }) => {
    // The space members dialog had no end-to-end coverage at all until now. A space IS a
    // room, so it has a creator, and the same Owner/Admin distinction applies — which is
    // only visible once two people share the top power level.
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}som`;
    const owner = `space-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const other = `space-admin-${runId}`;
    const otherPass = `${other}-pass`;
    const spaceName = `Owned ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, other, otherPass);
    const ownerToken = await apiLogin(request, hs, owner, ownerPass);
    const otherLogin = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: other },
          password: otherPass,
        },
      })
      .then((r) => r.json());
    const otherId = otherLogin.user_id as string;
    const spaceId = await createSpace(request, hs, ownerToken, spaceName);
    await joinAsMember(
      request,
      hs,
      ownerToken,
      spaceId,
      otherLogin.access_token as string,
      otherId,
    );
    // Promote them to the SAME power the creator holds — the case a power level alone
    // cannot tell apart. Read the CURRENT power levels and merge, rather than PUTting a
    // bare `users` map: this event also carries `events`, `state_default` and friends,
    // and replacing it wholesale would silently drop them.
    const ownerId = (
      await request
        .get(`${hs}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        })
        .then((r) => r.json())
    ).user_id as string;
    const currentPowers = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
        { headers: { Authorization: `Bearer ${ownerToken}` } },
      )
      .then((r) => r.json());
    const powersRes = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: {
          ...currentPowers,
          users: { ...currentPowers.users, [ownerId]: 100, [otherId]: 100 },
        },
      },
    );
    // Checked like every other request here: a 403 must fail loudly rather than surface
    // later as a confusing assertion timeout.
    if (!powersRes.ok()) {
      throw new Error(
        `set power levels → ${powersRes.status()} ${await powersRes.text()}`,
      );
    }

    await login(page, {
      available: true,
      hs,
      user: owner,
      pass: ownerPass,
    } as SynapseSession);
    await openSpaceMenu(page, spaceName);
    // Trigger and dialog are named apart, so this cannot resolve two nodes while the
    // menu is still on screen.
    await page.getByTestId('open-space-members').click();
    await expect(page.getByTestId('space-members')).toBeVisible({
      timeout: 10_000,
    });

    const ownerRow = page.getByTestId(`space-member-${ownerId}`);
    const otherRow = page.getByTestId(`space-member-${otherId}`);
    await expect(ownerRow).toContainText('Owner', { timeout: 20_000 });
    await expect(otherRow).toContainText('Admin');
  });
});
