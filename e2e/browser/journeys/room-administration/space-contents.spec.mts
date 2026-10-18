import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  openSettingsTab,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser, apiLogin } from '../../../support/account.mts';
import { createRoom, linkChild } from '../../support/space-journey.mts';

const session = homeserverSession();

async function childLink(
  request: APIRequestContext,
  hs: string,
  token: string,
  spaceId: string,
  childId: string,
): Promise<Record<string, unknown> | null> {
  const response = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return response.ok()
    ? ((await response.json()) as Record<string, unknown>)
    : null;
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
  await page.getByTestId('space-header').click();
}

// Self-skip without Docker, via test.info() so no describe wrapper is needed.
test.beforeEach(() => {
  test.info().skip(!session.available, 'needs a Synapse homeserver (Docker)');
});

test('an admin adds, creates, recovers and unlinks exact Space contents', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}contents`;
  const user = `space-contents-${runId}`;
  const pass = `${user}-pass`;
  const spaceName = `Contents ${runId}`;
  const linkedName = `Linked ${runId}`;
  const candidateName = `Candidate Room ${runId}`;
  const candidateSpaceName = `Candidate Space ${runId}`;
  const createdSpaceName = `Created Space ${runId}`;
  const recoveredName = `Recovered ${runId}`;

  await registerUser(request, user, pass);
  const account = await apiLogin(request, hs, user, pass);
  const { token } = account;
  const spaceId = await createRoom(
    request,
    hs,
    { accessToken: token },
    spaceName,
    { space: true },
  );
  const linkedId = await createRoom(
    request,
    hs,
    { accessToken: token },
    linkedName,
  );
  const candidateId = await createRoom(
    request,
    hs,
    { accessToken: token },
    candidateName,
  );
  const candidateSpaceId = await createRoom(
    request,
    hs,
    { accessToken: token },
    candidateSpaceName,
    { space: true },
  );
  await linkChild(request, hs, account, spaceId, linkedId);

  await login(page, { available: true, hs, user, pass } as HomeserverSession);
  await openSpaceMenu(page, spaceName);
  await page.getByTestId('open-space-settings').click();
  await openSettingsTab(page, 'space-settings', 'contents');

  const panel = page.getByTestId('space-settings-panel-contents');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(linkedName, { exact: true })).toBeVisible();
  await expect(panel.getByTestId(`space-content-${linkedId}`)).toContainText(
    'Room',
  );

  const openingRootSize = await page.evaluate(
    () => document.documentElement.style.fontSize,
  );
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '125%';
  });
  await expect(
    panel.getByRole('button', { name: 'Create space' }),
  ).toBeVisible();
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = size;
  }, openingRootSize);

  await panel.getByRole('button', { name: 'Add existing' }).click();
  await panel.getByLabel('Find a joined room or space').fill(`Candidate`);
  const candidateRoom = panel.getByTestId(`space-contents-pick-${candidateId}`);
  await candidateRoom.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  await panel.getByTestId(`space-contents-pick-${candidateSpaceId}`).click();
  await panel.getByRole('button', { name: 'Add selected' }).click();
  await expect
    .poll(() => childLink(request, hs, token, spaceId, candidateId), {
      timeout: 30_000,
    })
    .toEqual(expect.objectContaining({ via: expect.any(Array) }));
  await expect
    .poll(() => childLink(request, hs, token, spaceId, candidateSpaceId), {
      timeout: 30_000,
    })
    .toEqual(expect.objectContaining({ via: expect.any(Array) }));

  const createdSpaceResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/createRoom') &&
      response.ok(),
  );
  await panel.getByRole('button', { name: 'Create space' }).click();
  await page.getByPlaceholder('Space name').fill(createdSpaceName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const createdSpaceId = (
    (await (await createdSpaceResponse).json()) as {
      room_id: string;
    }
  ).room_id;
  await expect
    .poll(() => childLink(request, hs, token, spaceId, createdSpaceId), {
      timeout: 30_000,
    })
    .toEqual(expect.objectContaining({ via: expect.any(Array) }));
  await expect(
    panel.getByTestId(`space-content-${createdSpaceId}`),
  ).toContainText('Space', { timeout: 30_000 });

  // Force only the parent-link step to fail. Room creation must survive and expose its
  // id; retry then sends just the link, which proves the recovery path cannot duplicate it.
  const childRoute = '**/state/m.space.child/**';
  let createRequests = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/createRoom')) {
      createRequests += 1;
    }
  });
  await page.route(childRoute, (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({
        errcode: 'M_FORBIDDEN',
        error: 'link rejected',
      }),
    }),
  );
  await panel.getByRole('button', { name: 'Create room' }).click();
  await page.getByPlaceholder('Room name').fill(recoveredName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const recovery = panel.getByTestId('space-contents-recovery');
  await expect(recovery).toBeVisible({ timeout: 30_000 });
  await expect(recovery).toContainText(recoveredName);
  const recoveredId = (await recovery.locator('p').textContent())?.trim();
  expect(recoveredId).toMatch(/^!/);
  expect(createRequests).toBe(1);

  await page.unroute(childRoute);
  await recovery.getByRole('button', { name: 'Try linking again' }).click();
  await expect(recovery).toHaveCount(0);
  await expect
    .poll(() => childLink(request, hs, token, spaceId, recoveredId as string), {
      timeout: 30_000,
    })
    .toEqual(expect.objectContaining({ via: expect.any(Array) }));
  expect(createRequests).toBe(1);

  // Parent-owned hierarchy policy: retry did not invent a child-side governance write.
  const parentState = await request.get(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(recoveredId as string)}/state/m.space.parent/${encodeURIComponent(spaceId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(parentState.ok()).toBe(false);

  const linkedRow = panel.getByTestId(`space-content-${linkedId}`);
  await linkedRow.getByRole('button', { name: 'Remove' }).click();
  const removeDialog = page.getByRole('dialog', {
    name: 'Remove room from space',
  });
  await expect(removeDialog).toContainText(linkedName);
  await expect(removeDialog).toContainText(spaceName);
  await expect(removeDialog).toContainText('not deleted');
  await removeDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    childLink(request, hs, token, spaceId, linkedId),
  ).resolves.toEqual(expect.objectContaining({ via: expect.any(Array) }));

  await linkedRow.getByRole('button', { name: 'Remove' }).click();
  await removeDialog.getByRole('button', { name: 'Remove' }).click();
  await expect
    .poll(() => childLink(request, hs, token, spaceId, linkedId), {
      timeout: 30_000,
    })
    .toEqual({});
  const membership = await request
    .get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(linkedId)}/state/m.room.member/${encodeURIComponent(`@${user}:localhost`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    .then((response) => response.json());
  expect(membership.membership).toBe('join');

  await test.info().attach('space-contents-desktop', {
    body: await panel.screenshot(),
    contentType: 'image/png',
  });

  const createdSpaceRow = panel.getByTestId(`space-content-${createdSpaceId}`);
  await createdSpaceRow.getByRole('button', { name: 'Remove' }).click();
  const removeSpaceDialog = page.getByRole('dialog', {
    name: 'Remove space from space',
  });
  await expect(removeSpaceDialog).toContainText(createdSpaceName);
  await expect(removeSpaceDialog).toContainText(spaceName);
  await removeSpaceDialog.getByRole('button', { name: 'Remove' }).click();
  await expect
    .poll(() => childLink(request, hs, token, spaceId, createdSpaceId), {
      timeout: 30_000,
    })
    .toEqual({});
  const createdSpaceMembership = await request
    .get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(createdSpaceId)}/state/m.room.member/${encodeURIComponent(`@${user}:localhost`)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    .then((response) => response.json());
  expect(createdSpaceMembership.membership).toBe('join');

  const appearance = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    theme: document.documentElement.getAttribute('data-theme'),
  }));
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
    document.documentElement.setAttribute('data-theme', 'amethyst');
  });
  await test.info().attach('space-contents-desktop-dark-amethyst', {
    body: await panel.screenshot(),
    contentType: 'image/png',
  });
  await page.evaluate(({ dark, theme }) => {
    document.documentElement.classList.toggle('dark', dark);
    if (theme === null) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, appearance);

  const userId = `@${user}:localhost`;
  const powerLevels = await request
    .get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    .then((response) => response.json());
  const demote = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        ...powerLevels,
        users: { ...powerLevels.users, [userId]: 0 },
      },
    },
  );
  expect(demote.ok()).toBe(true);
  await expect(panel.getByTestId('space-contents-actions')).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    panel.getByTestId(`space-content-${candidateSpaceId}`),
  ).toBeVisible();
  await expect(
    panel.getByTestId(`space-content-unlink-${candidateSpaceId}`),
  ).toHaveCount(0);
  await expect(
    panel.getByTestId(`space-content-suggest-${candidateSpaceId}`),
  ).toHaveCount(0);
  await expect(
    panel.getByTestId(`space-content-move-up-${candidateSpaceId}`),
  ).toHaveCount(0);
});
