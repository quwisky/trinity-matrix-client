import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { addAccountViaUi } from '../../support/multi-account-journey.mts';

const session = synapseSession();

async function tokenFor(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  return request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((response) => response.json())
    .then((body) => body.access_token as string);
}

async function createSpace(
  request: APIRequestContext,
  hs: string,
  token: string,
  name: string,
  invite: readonly string[] = [],
): Promise<string> {
  return request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
        invite,
      },
    })
    .then((response) => response.json())
    .then((body) => body.room_id as string);
}

async function openSpaceSettings(page: Page, name: string): Promise<void> {
  const pill = page.getByRole('button', { name, exact: true });
  await pill.waitFor({ state: 'visible', timeout: 30_000 });
  await pill.click();
  await page.getByTestId('space-actions-overflow').click();
  await page.getByTestId('open-space-settings').click();
  await expect(page.getByTestId('space-settings')).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Space settings resilience', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('retains a partial General failure and retries only the unsaved field', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sppartial`;
    const user = `space-partial-${runId}`;
    const pass = `${user}-pass`;
    const spaceName = `Partial space ${runId}`;
    await registerUser(request, user, pass);
    const token = await tokenFor(request, hs, user, pass);
    await createSpace(request, hs, token, spaceName);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openSpaceSettings(page, spaceName);

    let nameWrites = 0;
    let topicWrites = 0;
    await page.route(
      /\/state\/m\.room\.(name|topic)(?:\/|\?|$)/,
      async (route) => {
        if (route.request().url().includes('m.room.name')) {
          nameWrites++;
          await route.continue();
          return;
        }
        topicWrites++;
        if (topicWrites === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ errcode: 'M_UNKNOWN', error: 'retry me' }),
          });
          return;
        }
        await route.continue();
      },
    );

    await page.getByTestId('space-settings-name').fill(`${spaceName} renamed`);
    await page.getByTestId('space-settings-topic').fill('Eventually saved');
    const save = page.getByTestId('space-settings-save');
    await save.click();
    const feedback = page.getByTestId('space-settings-general-feedback');
    await expect(feedback).toContainText('still unsaved', { timeout: 30_000 });
    expect(nameWrites).toBe(1);
    expect(topicWrites).toBe(1);

    // Retry through the keyboard so the error toast cannot obscure the action.
    await save.focus();
    await page.keyboard.press('Enter');
    await expect(feedback).toContainText('Topic saved', { timeout: 30_000 });
    expect(nameWrites).toBe(1);
    expect(topicWrites).toBe(2);
  });

  test('keeps late and subsequent writes on the opening Account after an Account switch', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}spaccount`;
    const owner = `space-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const member = `space-member-${runId}`;
    const memberPass = `${member}-pass`;
    const memberId = `@${member}:localhost`;
    const spaceName = `Shared space ${runId}`;
    await registerUser(request, owner, ownerPass);
    await registerUser(request, member, memberPass);
    const ownerToken = await tokenFor(request, hs, owner, ownerPass);
    const memberToken = await tokenFor(request, hs, member, memberPass);
    const spaceId = await createSpace(request, hs, ownerToken, spaceName, [
      memberId,
    ]);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/join`,
      { headers: { Authorization: `Bearer ${memberToken}` } },
    );

    await login(page, {
      available: true,
      hs,
      user: owner,
      pass: ownerPass,
    } as SynapseSession);
    await addAccountViaUi(page, hs, member, memberPass);
    await page.getByTestId('user-menu-trigger').click();
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${owner}:` })
      .click();
    await openSpaceSettings(page, spaceName);
    await expect(page.getByTestId('space-settings-account')).toContainText(
      owner,
    );

    let releaseName!: () => void;
    const nameGate = new Promise<void>((resolve) => {
      releaseName = resolve;
    });
    await page.route(/\/state\/m\.room\.name(?:\/|\?|$)/, async (route) => {
      await nameGate;
      await route.continue();
    });
    await page.getByTestId('space-settings-name').fill(`${spaceName} renamed`);
    await page.getByTestId('space-settings-save').click();
    await expect(page.getByTestId('space-settings-save')).toContainText(
      'Saving',
    );

    await page
      .getByTestId('user-menu-trigger')
      .evaluate((element: HTMLElement) => element.click());
    await page
      .getByTestId('account-row')
      .filter({ hasText: `@${member}:` })
      .click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${member}:`);
    await expect(page.getByTestId('space-settings-account')).toContainText(
      owner,
    );
    releaseName();
    await expect(
      page.getByTestId('space-settings-general-feedback'),
    ).toContainText('Name saved', { timeout: 30_000 });

    // The active member cannot change Space state, so this succeeds only through the
    // retained opening Account client.
    await page
      .getByTestId('space-settings-topic')
      .fill('Owned by opening Account');
    await page.getByTestId('space-settings-save').click();
    await expect(
      page.getByTestId('space-settings-general-feedback'),
    ).toContainText('Topic saved', { timeout: 30_000 });
    const topic = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.topic`,
        { headers: { Authorization: `Bearer ${memberToken}` } },
      )
      .then((response) => response.json());
    expect(topic.topic).toBe('Owned by opening Account');
  });
});
