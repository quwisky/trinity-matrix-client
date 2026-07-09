import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// End-to-end for member role sections: the room member list groups joined members
// under "Admin" / "Moderator" / "Member" headers derived from each member's power
// level (100 = admin, 50 = moderator, the Element convention), each header showing
// its count, and re-partitions live when a member is promoted. This drives a real
// Synapse room whose members carry distinct power levels, so it proves the whole
// path — SDK power levels → data-access projection → the grouped member list.
// Needs a Synapse homeserver (Docker); self-skips otherwise like the other web specs.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

/** A joined participant we can assert on by user id and display name. */
interface Participant extends ApiUser {
  name: string;
  power: number;
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

/** Give a user a stable display name so section membership doesn't depend on
 * Synapse's default-displayname behaviour. Set before the room-member event is
 * created (creation/join), so that event captures the name. */
async function setDisplayName(
  request: APIRequestContext,
  hs: string,
  actor: ApiUser,
  name: string,
): Promise<void> {
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(actor.userId)}/displayname`,
    { headers: actor.headers, data: { displayname: name } },
  );
}

/** Merge one user's power level into a room's `m.room.power_levels` (preserving the
 * rest of the content), as the admin. Drives the live-promotion re-partition. */
async function setPowerLevel(
  request: APIRequestContext,
  hs: string,
  actor: ApiUser,
  roomId: string,
  userId: string,
  level: number,
): Promise<void> {
  const url = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`;
  const current = await request
    .get(url, { headers: actor.headers })
    .then((r) => r.json());
  await request.put(url, {
    headers: actor.headers,
    data: { ...current, users: { ...(current.users ?? {}), [userId]: level } },
  });
}

/**
 * Register a reader (the room creator, so power level 100 = admin) plus one extra
 * participant per `powers` entry, set every display name, create the room inviting
 * all extras with a `power_level_content_override` that grants each their level, and
 * have every extra join. The result is a synced room whose member list spans the
 * requested roles.
 */
async function seedRoleRoom(
  request: APIRequestContext,
  hs: string,
  runId: string,
  powers: number[],
): Promise<{
  reader: SynapseSession;
  roomName: string;
  roomId: string;
  admin: Participant;
  extras: Participant[];
}> {
  const roomName = `Roles E2E ${runId}`;
  const readerUser = `roles-admin-${runId}`;
  const readerPass = `${readerUser}-pass`;

  await registerUser(request, readerUser, readerPass);
  const readerApi = await apiLogin(request, hs, readerUser, readerPass);
  const adminName = `Admin ${runId}`;
  await setDisplayName(request, hs, readerApi, adminName);
  const admin: Participant = { ...readerApi, name: adminName, power: 100 };

  const extras: Participant[] = [];
  for (let i = 0; i < powers.length; i++) {
    const user = `roles-p${i}-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const api = await apiLogin(request, hs, user, pass);
    const name = `Person ${i} ${runId}`;
    await setDisplayName(request, hs, api, name);
    extras.push({ ...api, name, power: powers[i] });
  }

  // Only levels above the default (0) need an override; the creator must be listed
  // explicitly at 100 because the override replaces the generated `users` map.
  const users: Record<string, number> = { [admin.userId]: 100 };
  for (const extra of extras) {
    if (extra.power > 0) {
      users[extra.userId] = extra.power;
    }
  }

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: admin.headers,
      data: {
        name: roomName,
        invite: extras.map((e) => e.userId),
        power_level_content_override: { users },
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  for (const extra of extras) {
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: extra.headers },
    );
  }

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
    roomId,
    admin,
    extras,
  };
}

/** Open the seeded room and make sure the member panel is showing. */
async function openRoomWithMembers(
  page: Page,
  roomName: string,
): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.locator('.scroll')).toBeVisible({ timeout: 15_000 });

  const members = page.locator('.members');
  if (!(await members.isVisible().catch(() => false))) {
    await page.getByTestId('toggle-members').click();
  }
  await expect(members).toBeVisible({ timeout: 15_000 });
}

/** The role section whose header contains `roleWord` (e.g. "Admin", "Moderator"). */
function sectionFor(page: Page, roleWord: string): Locator {
  return page.locator('.members__section').filter({
    has: page.locator('.members__section-label', { hasText: roleWord }),
  });
}

test.describe('Member role sections', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('groups members under Admin / Moderator / Member headers', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}r`;
    // Extras: one moderator (50) and one plain member (0); the reader is the admin (100).
    const { reader, roomName, admin, extras } = await seedRoleRoom(
      request,
      session.hs as string,
      runId,
      [50, 0],
    );
    const [moderator, plain] = extras;

    await login(page, reader);
    await openRoomWithMembers(page, roomName);

    // All three members sync into the list before we assert the grouping.
    await expect(page.locator('.members .member')).toHaveCount(3, {
      timeout: 20_000,
    });

    // Three sections, highest role first, each showing its count.
    await expect(page.locator('.members__section-label')).toHaveText([
      'Admin — 1',
      'Moderator — 1',
      'Member — 1',
    ]);

    // Each section is a named group for assistive tech (role + pluralised count).
    const groupLabels = await page
      .locator('.members__section')
      .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    expect(groupLabels).toEqual([
      'Admin, 1 member',
      'Moderator, 1 member',
      'Member, 1 member',
    ]);

    // The right member sits under the right header (matched by user id via [title]).
    await expect(sectionFor(page, 'Admin').locator('.member')).toHaveAttribute(
      'title',
      admin.userId,
    );
    await expect(
      sectionFor(page, 'Moderator').locator('.member'),
    ).toHaveAttribute('title', moderator.userId);
    await expect(sectionFor(page, 'Member').locator('.member')).toHaveAttribute(
      'title',
      plain.userId,
    );
    await expect(
      sectionFor(page, 'Moderator').locator('.member__name'),
    ).toHaveText(moderator.name);
  });

  test('re-partitions live when a member is promoted to moderator', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}p`;
    // Just the admin (reader) and one plain member (0) to start.
    const { reader, roomName, roomId, admin, extras } = await seedRoleRoom(
      request,
      session.hs as string,
      runId,
      [0],
    );
    const [plain] = extras;

    await login(page, reader);
    await openRoomWithMembers(page, roomName);

    await expect(page.locator('.members .member')).toHaveCount(2, {
      timeout: 20_000,
    });
    await expect(page.locator('.members__section-label')).toHaveText([
      'Admin — 1',
      'Member — 1',
    ]);

    // Promote the plain member to moderator server-side; the open client should
    // re-partition once the power-levels change syncs (assertion auto-retries).
    await setPowerLevel(
      request,
      session.hs as string,
      { userId: admin.userId, headers: admin.headers },
      roomId,
      plain.userId,
      50,
    );

    await expect(page.locator('.members__section-label')).toHaveText(
      ['Admin — 1', 'Moderator — 1'],
      { timeout: 20_000 },
    );
    await expect(
      sectionFor(page, 'Moderator').locator('.member'),
    ).toHaveAttribute('title', plain.userId);
  });
});
