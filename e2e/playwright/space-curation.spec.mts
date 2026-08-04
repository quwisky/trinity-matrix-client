import { createHmac } from 'node:crypto';
import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers the space-curation half of #40: adding a room you are ALREADY in to a space
// (until now a room could only join a space by being created in it), flagging a child as
// `suggested`, and setting the `order` that everyone — not just you — sees.
//
// Asserted against the `m.space.child` state event over the CS API, because that event is
// the whole feature: a UI that reordered a list locally and wrote nothing looks identical.
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
    const runId = `${Date.now().toString(36)}ad`;
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
    const runId = `${Date.now().toString(36)}sub`;
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
    const runId = `${Date.now().toString(36)}cu`;
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
  });
});
