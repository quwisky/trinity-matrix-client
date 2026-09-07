import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { fillLabeledInput, login, synapseSession, waitForRooms } from '../support/app.mts';
import { passwordLogin, registerUser, type AccountSession } from '../support/account.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';
import { expect, test } from './fixtures.mts';

const session = synapseSession();

async function createRoom(request: APIRequestContext, resources: MatrixTestResources, account: AccountSession, name: string): Promise<string> {
  const headers = { Authorization: `Bearer ${account.accessToken}` };
  const created = await request.post(`${session.hs}/_matrix/client/v3/createRoom`, { headers, data: { name } });
  expect(created.ok()).toBe(true);
  const { room_id: roomId } = await created.json() as { room_id: string };
  resources.cleanup(`leave ${roomId}`, async () => {
    const result = await request.post(`${session.hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, { headers });
    expect(result.ok()).toBe(true);
  });
  return roomId;
}

async function addAccount(page: Page, user: string, password: string): Promise<void> {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('add-account').click();
  await expect(page.getByTestId('cancel-add')).toBeVisible();
  await fillLabeledInput(page, 'Homeserver', session.hs!);
  await page.getByText('Continue', { exact: true }).click();
  await page.getByRole('button', { name: 'Sign in' }).waitFor({ timeout: 30_000 });
  await fillLabeledInput(page, 'Username', user);
  await fillLabeledInput(page, 'Password', password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await waitForRooms(page);
}

async function selectAccount(page: Page, userId: string): Promise<void> {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('account-row').filter({ hasText: userId }).click();
  await expect(page.locator('.userbar__handle')).toContainText(userId);
}

async function expectConversation(page: Page, userId: string, heading: string): Promise<void> {
  await expect(page).toHaveURL(/\/rooms\//, { timeout: 30_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get('account')).toBe(userId);
  await expect(page.locator('h1')).toHaveText(heading, { timeout: 30_000 });
  await expect(page.getByTestId('composer-input')).toBeVisible();
}

test.describe('Android background push delivery', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('opens an inactive Account and Conversation from cold and warm notifications', async ({ app, page, request, matrixResources }) => {
    test.setTimeout(180_000);
    const bUser = matrixResources.userLocalpart('push-recipient');
    const bPass = `${bUser}-pass`;
    await registerUser(request, bUser, bPass);
    const b = await passwordLogin(request, session.hs!, bUser, bPass);
    const bRoomName = matrixResources.roomName('android-account-b-room');
    const roomId = await createRoom(request, matrixResources, b, bRoomName);
    await login(page, session, app.navigate);
    await waitForRooms(page, 30_000);
    const a = await passwordLogin(request, session.hs!, session.user!, session.pass!);
    const aRoomName = matrixResources.roomName('android-account-a-room');
    await createRoom(request, matrixResources, a, aRoomName);
    await addAccount(page, bUser, bPass);
    const accountId = b.userId;
    const route = randomUUID();
    await page.getByTestId('rail-rooms').click();
    await expect(page.locator('.channel', { hasText: bRoomName }).first()).toBeVisible({ timeout: 30_000 });
    await selectAccount(page, a.userId);
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: aRoomName }).first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    const roomHeading = `#${bRoomName}`;

    // Starting instrumentation creates a fresh application process. Its native
    // handler receives the payload before any Activity or WebView is running.
    await app.pressKey(3);
    await app.deliverPush(route, '$event:android-cold', roomId, '$event:android-warm', accountId);
    const coldPage = await app.attachAfterNotification();
    await expectConversation(coldPage, accountId, roomHeading);

    // Move back to A before backgrounding, so a stale B surface cannot satisfy
    // the second activation. The instrumentation and app processes stay alive.
    await selectAccount(coldPage, a.userId);
    await coldPage.getByTestId('rail-rooms').click();
    await coldPage.locator('.channel', { hasText: aRoomName }).first().click();
    await expect(coldPage.getByTestId('composer-input')).toBeVisible();
    await app.pressKey(3);
    await app.deliverPush(route, '$event:android-warm', roomId);
    const warmPage = await app.attachAfterNotification();
    await expectConversation(warmPage, accountId, roomHeading);
    await app.finishPushDelivery();
  });
});
