import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  openSettingsTab,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers the space-curation half of #40: adding a room you are ALREADY in to a space
// (until now a room could only join a space by being created in it), flagging a child as
// `suggested`, and setting the `order` that everyone — not just you — sees.
//
// Asserted against the `m.space.child` state event over the CS API, because that event is
// the whole feature: a UI that reordered a list locally and wrote nothing looks identical.
// Creating a subspace and joining a child run through android.space-curation-create-join
// (#695), which also runs adding an existing room on Android.
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
    test.skip(
      isAndroidE2E,
      'Android runs this through android.space-curation-create-join (#695).',
    );
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
    const panel = page.getByTestId('space-settings-panel-contents');
    await expect(panel).toBeVisible({
      timeout: 10_000,
    });
    await expectOpaque(page, 'space-settings');

    // Personal ordering is a separate Account-and-device preference. Give it a
    // non-default value before shared curation so the shared writes below can prove they
    // never overwrite it.
    await openSettingsTab(page, 'space-settings', 'for-you');
    await page.getByTestId('space-settings-order-alphabetical').click();
    await page.getByTestId('space-settings-for-you-save').click();
    await expect(
      page.getByTestId('space-settings-for-you-feedback'),
    ).toContainText('saved for this Account on this device');
    await openSettingsTab(page, 'space-settings', 'contents');

    // First refusal: the optimistic checkbox must roll back and preserve a retryable
    // command rather than presenting an uncommitted Suggested state.
    const childRoute = `**/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(second)}`;
    await page.route(childRoute, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({
          errcode: 'M_FORBIDDEN',
          error: 'curation rejected',
        }),
      }),
    );
    const suggested = panel
      .getByTestId(`space-content-suggest-${second}`)
      .getByRole('checkbox');
    await suggested.focus();
    await page.keyboard.press('Space');
    const failure = panel.getByTestId('space-content-curation-failure');
    await expect(failure).toContainText('curation rejected');
    await expect(suggested).not.toBeChecked();
    await page.unroute(childRoute);

    // Retry against the real server, but pause the request. All conflicting controls must
    // remain disabled through the response boundary and until the synced echo reaches the
    // exact Account projection.
    let releaseWrite = (): void => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let heldWrite = false;
    await page.route(childRoute, async (route) => {
      if (!heldWrite) {
        heldWrite = true;
        await writeGate;
      }
      await route.continue();
    });
    await failure.getByRole('button', { name: 'Try again' }).click();
    const moveUp = panel.getByTestId(`space-content-move-up-${second}`);
    await expect(moveUp).toBeDisabled();
    releaseWrite();
    await expect
      .poll(
        async () =>
          (await childLink(request, hs, token, spaceId, second))?.['suggested'],
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.unroute(childRoute);
    await expect(moveUp).toBeEnabled({ timeout: 30_000 });

    await moveUp.focus();
    await page.keyboard.press('Enter');

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

    await openSettingsTab(page, 'space-settings', 'for-you');
    await expect(
      page
        .getByTestId('space-settings-order-alphabetical')
        .getByRole('radio', { name: 'Alphabetical' }),
    ).toBeChecked();
    await openSettingsTab(page, 'space-settings', 'contents');

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

    await expect(panel.getByTestId(`space-content-${third}`)).toBeVisible({
      timeout: 30_000,
    });
  });
});
