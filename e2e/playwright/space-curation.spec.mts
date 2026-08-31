import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../fixtures.mts';
import { login, synapseSession, type SynapseSession } from '../support/app.mts';
import { registerUser } from '../support/account.mts';

// Covers the space-curation half of #40: adding a room you are ALREADY in to a space
// (until now a room could only join a space by being created in it), flagging a child as
// `suggested`, and setting the `order` that everyone — not just you — sees.
//
// Asserted against the `m.space.child` state event over the CS API, because that event is
// the whole feature: a UI that reordered a list locally and wrote nothing looks identical.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

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

async function createRoom(
  request: APIRequestContext,
  hs: string,
  token: string,
  data: Record<string, unknown>,
): Promise<string> {
  const res = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${token}` },
    data,
  });
  if (!res.ok()) {
    throw new Error(`createRoom → ${res.status()} ${await res.text()}`);
  }
  return (await res.json()).room_id as string;
}

/** The `m.space.child` content for one child, or undefined when there is no link. */
async function childLink(
  request: APIRequestContext,
  hs: string,
  token: string,
  spaceId: string,
  childId: string,
): Promise<Record<string, unknown> | undefined> {
  const res = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return res.ok() ? await res.json() : undefined;
}

/**
 * Assert a dialog paints an opaque surface.
 *
 * The CDK dialog panel is transparent, so a dialog that forgets its own background renders
 * as floating text over the timeline. Nothing else catches it: the markup is correct, the
 * component tests pass, and jsdom has no computed styles — it is only visible on screen.
 */
async function expectOpaque(page: Page, testId: string): Promise<void> {
  const background = await page
    .getByTestId(testId)
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  // rgba(..., 0) and `transparent` are the failure; anything else has a surface.
  expect(background).not.toMatch(/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/);
}

test.describe('Space curation', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('an admin adds an existing room to a space', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ad`;
    const user = `curate-add-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Curated ${runId}`;
    const roomName = `Existing ${runId}`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createRoom(request, hs, token, {
      name: spaceName,
      preset: 'private_chat',
      creation_content: { type: 'm.space' },
    });
    // Created OUTSIDE the space — the case that had no path into one before.
    const roomId = await createRoom(request, hs, token, {
      name: roomName,
      preset: 'private_chat',
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    const pill = page.getByRole('button', { name: spaceName, exact: true });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();
    await page.getByTestId('space-actions-overflow').click();
    await page.getByTestId('space-add-rooms').click();

    await expect(page.getByTestId('add-to-space')).toBeVisible({
      timeout: 10_000,
    });
    await expectOpaque(page, 'add-to-space');
    await page.getByTestId(`add-to-space-pick-${roomId}`).click();
    await page.getByTestId('add-to-space-add').click();

    // The link is what puts the room in the space, and its `via` is what makes the room
    // reachable — a link written without one is worse than no link at all.
    await expect
      .poll(async () => await childLink(request, hs, token, spaceId, roomId), {
        timeout: 30_000,
      })
      .toEqual(expect.objectContaining({ via: expect.any(Array) }));
    const link = await childLink(request, hs, token, spaceId, roomId);
    expect((link?.['via'] as string[]).length).toBeGreaterThan(0);
  });

  test('an admin creates a space inside a space', async ({ page, request }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sub`;
    const user = `curate-sub-${runId}`;
    const pass = `${user}-pass`;
    const parentName = `Parent ${runId}`;
    const childName = `Child ${runId}`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const parentId = await createRoom(request, hs, token, {
      name: parentName,
      preset: 'private_chat',
      creation_content: { type: 'm.space' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    const pill = page.getByRole('button', { name: parentName, exact: true });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();
    await page.getByTestId('space-actions-overflow').click();
    await page.getByTestId('space-create-subspace').click();

    // Target the prompt's own field by its placeholder, not `getByRole('textbox').last()`.
    // That form does not wait for the dialog — it resolves against whatever textboxes are
    // on the page at that instant, and the shell always has some (the sidebar filter, the
    // composer). If the prompt has not opened yet it fills one of those instead, `Create`
    // then submits an empty name, no subspace is ever created, and the failure surfaces
    // 60s later as "no m.space.child link appeared on the parent" — pointing at the
    // server rather than at the typing. Waiting on the placeholder waits for the dialog.
    const nameField = page.getByPlaceholder('Space name');
    await nameField.waitFor({ state: 'visible', timeout: 10_000 });
    await nameField.fill(childName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // Two writes: the space is created, then linked into its parent. The LINK is what
    // makes it a subspace rather than just another space, so assert on that.
    const childId = await new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + 60_000;
      const poll = async () => {
        const res = await request.get(
          `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(parentId)}/state`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (res.ok()) {
          const events = (await res.json()) as {
            type: string;
            state_key: string;
            content: Record<string, unknown>;
          }[];
          const link = events.find(
            (event) =>
              event.type === 'm.space.child' &&
              Array.isArray(event.content['via']) &&
              (event.content['via'] as unknown[]).length > 0,
          );
          if (link) {
            resolve(link.state_key);
            return;
          }
        }
        if (Date.now() > deadline) {
          reject(new Error('no m.space.child link appeared on the parent'));
          return;
        }
        setTimeout(poll, 1000);
      };
      void poll();
    });

    // And the linked child really is a space, not a plain room.
    const created = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(childId)}/state/m.room.create/`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((r) => r.json());
    expect(created.type).toBe('m.space');
  });

  test('an admin suggests and reorders a space’s rooms', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}cu`;
    const user = `curate-order-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Ordered ${runId}`;

    await registerUser(request, user, pass);
    const token = await apiLogin(request, hs, user, pass);
    const spaceId = await createRoom(request, hs, token, {
      name: spaceName,
      preset: 'private_chat',
      creation_content: { type: 'm.space' },
    });
    const first = await createRoom(request, hs, token, {
      name: `Aaa ${runId}`,
      preset: 'private_chat',
    });
    const second = await createRoom(request, hs, token, {
      name: `Bbb ${runId}`,
      preset: 'private_chat',
    });
    for (const [index, childId] of [first, second].entries()) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          // Deliberately adjacent-but-spaced keys so a single move needs no renumber.
          data: { via: ['localhost'], order: index === 0 ? '5' : 'F' },
        },
      );
    }

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    const pill = page.getByRole('button', { name: spaceName, exact: true });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();
    await page.getByTestId('space-actions-overflow').click();
    await page.getByTestId('space-manage-rooms').click();
    await expect(page.getByTestId('manage-space-rooms')).toBeVisible({
      timeout: 10_000,
    });
    await expectOpaque(page, 'manage-space-rooms');

    // Suggest the second room, then move it above the first.
    await page.getByTestId(`suggest-${second}`).click();
    await expect
      .poll(
        async () =>
          (await childLink(request, hs, token, spaceId, second))?.['suggested'],
        { timeout: 30_000 },
      )
      .toBe(true);

    await page.getByTestId(`move-up-${second}`).click();

    // The order key must now sort BEFORE the first room's, and the write must not have
    // dropped `via` — re-sending a child event replaces it wholesale.
    await expect
      .poll(
        async () => {
          const link = await childLink(request, hs, token, spaceId, second);
          const order = link?.['order'];
          return typeof order === 'string' && order < '5';
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const moved = await childLink(request, hs, token, spaceId, second);
    expect((moved?.['via'] as string[])?.length).toBeGreaterThan(0);
    // And the suggestion it already carried survived the reorder.
    expect(moved?.['suggested']).toBe(true);

    // A third room linked into the space from OUTSIDE this browser, with the dialog still
    // open — the direction every other assertion here is blind to. The rest of this spec
    // drives the UI and then reads the server, so it catches a UI that writes nothing; it
    // cannot catch state that was written and never reaches the screen.
    //
    // What this does NOT prove is which dependency carries it. `childList` also reads a
    // name lookup over `rooms()` and `spaces()`, both of which hand back a fresh array on
    // every rebuild, and `SpacesService` refreshes on `m.space.child` too — so the list
    // re-reads even when its dependency on the links is severed. Verified, not assumed:
    // wrapping the link read in `untracked` leaves this test green. The declared
    // dependency is pinned in space-children.service.spec.ts, where no name lookup exists
    // to carry it. This assertion guards the user-visible behaviour end to end.
    const third = await createRoom(request, hs, token, {
      name: `Ccc ${runId}`,
      preset: 'private_chat',
    });
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(third)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { via: ['localhost'], order: 'z' },
      },
    );

    await expect(page.getByTestId(`managed-${third}`)).toBeVisible({
      timeout: 30_000,
    });
  });

  test('a child moves out of More Channels the moment you join it', async ({
    page,
    request,
  }) => {
    // The `joined` flag on a space's children is derived from sync, not from the
    // `/hierarchy` fetch that produced the list — so joining has to move a room from
    // "More Channels" into the channel list with no re-fetch and no reload. That
    // derivation is the whole reason SpacesService carried a bump counter.
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}jn`;
    const owner = `spacer-${runId}`;
    const pass = `${owner}-pass`;
    // A second account, because the room has to be one the viewer is NOT in. Anything
    // this user creates, they are joined to.
    const other = `other-${runId}`;
    const spaceName = `Joinable ${runId}`;
    const childName = `Lobby ${runId}`;

    await registerUser(request, owner, pass);
    await registerUser(request, other, pass);
    const ownerToken = await apiLogin(request, hs, owner, pass);
    const otherToken = await apiLogin(request, hs, other, pass);

    const spaceId = await createRoom(request, hs, ownerToken, {
      name: spaceName,
      preset: 'private_chat',
      creation_content: { type: 'm.space' },
    });
    // Public, so the viewer can actually join it from the sidebar.
    const childId = await createRoom(request, hs, otherToken, {
      name: childName,
      preset: 'public_chat',
    });
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
      {
        headers: { Authorization: `Bearer ${ownerToken}` },
        data: { via: ['localhost'] },
      },
    );

    await login(page, {
      available: true,
      hs,
      user: owner,
      pass,
    } as SynapseSession);
    const pill = page.getByRole('button', { name: spaceName, exact: true });
    await pill.waitFor({ state: 'visible', timeout: 30_000 });
    await pill.click();

    // Not joined yet: offered under More Channels rather than listed as a channel.
    const join = page.getByTestId(`join-child-${childId}`);
    await expect(join).toBeVisible({ timeout: 30_000 });

    await join.click();

    // Gone from the joinable list, and present as a channel — both halves, because
    // disappearing without appearing would look the same to a half-broken derivation.
    await expect(join).toBeHidden({ timeout: 30_000 });
    // A channel row's accessible name is its avatar initial then its name ("L Lobby …"),
    // so anchor on that shape: a bare substring match would also hit the row's own
    // "Options for Lobby …" button and pass without the row existing.
    await expect(
      page.getByRole('button', { name: new RegExp(`^\\S+ ${childName}$`) }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
