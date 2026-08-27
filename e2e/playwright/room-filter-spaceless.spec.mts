import { test, expect, type APIRequestContext } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the "Rooms view excludes space-owned rooms" behavior: the flat Rooms
// view (revealed by the `rail-rooms` pill) lists only non-DM joined rooms that
// do NOT belong to any space — a room that is a child of a space (linked via
// `m.space.child`) surfaces under that space's pill instead
// (RoomsPage.visibleRooms / spaceChildRoomIds in rooms.page.ts).
//
// Seeds a fresh reader via Synapse's shared-secret admin endpoint (same trick
// as room-list.spec.mts/unread-badges.spec.mts) with:
//   - a spaceless plain room ("Freestanding")
//   - a space ("Team") with a child plain room ("Team Chat") the reader has
//     joined, linked via a `m.space.child` state event on the space (mirroring
//     SpacesService.createRoomInSpace's own via/link shape)
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise, like the other
// authenticated web e2e specs.
const session = synapseSession();

const HS_SERVER_NAME = 'localhost';

interface ApiUser {
  token: string;
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
    token: json.access_token as string,
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

/**
 * Register a fresh reader, then create (as that reader, so it's auto-joined
 * to everything): a spaceless plain room, a space, and a plain room linked
 * into the space as its child via `m.space.child` — mirroring
 * SpacesService.createRoomInSpace's own request shapes (creation_content for
 * the space, then a `m.space.child` state event with a non-empty `via` on the
 * space pointing at the child, which is what SpacesService.orderedChildIds
 * requires to surface a *joined* child).
 */
async function seedSpaceAndRooms(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  reader: SynapseSession;
  freestandingName: string;
  spaceName: string;
  childName: string;
}> {
  const readerUser = `reader-${runId}`;
  const readerPass = `reader-pass-${runId}`;
  const freestandingName = `Freestanding ${runId}`;
  const spaceName = `Team ${runId}`;
  const childName = `Team Chat ${runId}`;

  await registerUser(request, readerUser, readerPass);
  const reader = await apiLogin(request, hs, readerUser, readerPass);

  // A spaceless plain (non-DM) room — should stay in the flat Rooms view.
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: reader.headers,
    data: { name: freestandingName, preset: 'private_chat' },
  });

  // A space (a room with creation_content.type: m.space), matching
  // SpacesService.createSpace.
  const spaceId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  // Its child room — a plain room the reader joins by virtue of creating it.
  const childId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: childName, preset: 'private_chat' },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  // Link the child into the space: `m.space.child` on the space, state-keyed
  // by the child's room id, carrying a non-empty `via` — the shape
  // SpacesService.orderedChildIds requires to treat the link as valid (an
  // empty-content link is its tombstone for a removed child).
  const linkRes = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(
      spaceId,
    )}/state/m.space.child/${encodeURIComponent(childId)}`,
    {
      headers: reader.headers,
      data: { via: [HS_SERVER_NAME], suggested: true },
    },
  );
  if (!linkRes.ok()) {
    throw new Error(
      `m.space.child ${spaceId}→${childId} → ${linkRes.status()} ${await linkRes.text()}`,
    );
  }

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    freestandingName,
    spaceName,
    childName,
  };
}

test.describe('Rooms view excludes space-owned rooms', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a spaceless room stays in the flat Rooms list; a space child moves under its space pill', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}s`;

    const { reader, freestandingName, spaceName, childName } =
      await seedSpaceAndRooms(request, hs, runId);

    await login(page, reader);

    // Reveal the flat Rooms view (non-DM rooms) via the rail pill.
    await page.getByTestId('rail-rooms').click();

    const freestandingRow = page.locator('.channel', {
      hasText: freestandingName,
    });
    await freestandingRow
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });

    // Assert against a settled sidebar (Freestanding has landed from sync) —
    // not a race against the space child never showing up.
    await expect(page.locator('.channel', { hasText: childName })).toHaveCount(
      0,
    );

    // The space child wasn't lost — it should be listed under its space.
    // ServerRailComponent renders one pill per joined space, each an
    // `aria-label`/`title`-ed button named after the space (no dedicated
    // testid on the pill itself — see server-rail.component.ts).
    const spacePill = page.getByRole('button', {
      name: spaceName,
      exact: true,
    });
    await spacePill.waitFor({ state: 'visible', timeout: 30_000 });

    const spaceRadii = () =>
      spacePill.evaluate((pill) => {
        const host = pill.querySelector('trn-avatar');
        const avatar = pill.querySelector('hlm-avatar');
        const fallback = pill.querySelector('[data-slot="avatar-fallback"]');
        if (!host || !avatar || !fallback) {
          throw new Error('space pill avatar did not render its fallback');
        }
        return {
          shape: host.getAttribute('data-shape'),
          pill: getComputedStyle(pill).borderRadius,
          avatar: getComputedStyle(avatar).borderRadius,
          fallback: getComputedStyle(fallback).borderRadius,
          outline: getComputedStyle(avatar, '::after').borderRadius,
        };
      });
    const assertStablePlaceGeometry = (
      radii: Awaited<ReturnType<typeof spaceRadii>>,
    ) => {
      expect(radii.shape).toBe('place');
      expect(
        new Set([radii.pill, radii.avatar, radii.fallback, radii.outline]).size,
      ).toBe(1);
      expect(radii.avatar).not.toBe('50%');
    };

    const restingRadii = await spaceRadii();
    assertStablePlaceGeometry(restingRadii);
    await spacePill.hover();
    const hoveredRadii = await spaceRadii();
    assertStablePlaceGeometry(hoveredRadii);
    expect(hoveredRadii).toEqual(restingRadii);

    await spacePill.click();
    const selectedRadii = await spaceRadii();
    assertStablePlaceGeometry(selectedRadii);
    expect(selectedRadii).toEqual(restingRadii);

    const childRow = page.locator('.channel', { hasText: childName });
    await childRow.first().waitFor({ state: 'visible', timeout: 30_000 });
    await expect(childRow.first().locator('.channel__name')).toHaveText(
      childName,
    );
  });
});
