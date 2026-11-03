import type { TestInfo } from '@playwright/test';
import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  homeserverSession,
  login,
  type HomeserverSession,
} from '../../../support/app.mts';
import { apiLogin, registerUser } from '../../../support/account.mts';
import { openNamedRoom } from '../../../support/message-composer.mts';
import {
  cdpSwipe,
  sheetAtRest,
  touchLongPress,
} from '../../../support/touch-platform.mts';
import { sendWithRetry } from '../../support/cs-api.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';

// The long sheets (Settings, System status, the reactions list) open at half height on a
// phone, drag to full height and back, and close from half height. Action sheets keep
// their content's height. Needs a Synapse homeserver (Docker).
const session = homeserverSession();
const HEIGHT = 844;
const TOP_INSET = 47;

async function dark(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}

async function attach(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** The sheet's top once it has held still for a few frames, so a snap has finished. */
async function settledTop(sheet: Locator): Promise<number> {
  return sheet.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        let last = -1;
        let still = 0;
        const frame = () => {
          const top = Math.round(element.getBoundingClientRect().top);
          still = top === last ? still + 1 : 0;
          last = top;
          if (still >= 5) resolve(top);
          else requestAnimationFrame(frame);
        };
        // A screenshot or a drag cancels the entrance, so a cancelled animation counts as done.
        void Promise.allSettled(
          element.getAnimations().map((a) => a.finished),
        ).then(() => requestAnimationFrame(frame));
      }),
  );
}

async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = (await target.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Drags the sheet's handle by `dy` px. */
async function dragHandle(page: Page, sheet: Locator, dy: number) {
  const from = await centre(sheet.getByTestId('sheet-handle'));
  await cdpSwipe(page, from, { x: from.x, y: from.y + dy });
}

async function expectMedium(sheet: Locator): Promise<void> {
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'medium');
  expect(Math.abs((await settledTop(sheet)) - HEIGHT / 2)).toBeLessThanOrEqual(
    2,
  );
}

async function expectLarge(sheet: Locator): Promise<void> {
  await expect(sheet).toHaveAttribute('data-sheet-detent', 'large');
  const top = await settledTop(sheet);
  expect(top).toBeGreaterThanOrEqual(TOP_INSET);
  expect(top).toBeLessThanOrEqual(TOP_INSET + 4);
}

/** Up to full, back to half, then closed: the drag every detent sheet shares. */
async function expectDetentDrag(page: Page, dialog: Locator): Promise<void> {
  const sheet = surface(dialog);
  await dragHandle(page, sheet, -300);
  await expectLarge(sheet);
  await dragHandle(page, sheet, 300);
  await expectMedium(sheet);
  await dragHandle(page, sheet, 300);
  await expect(dialog).toHaveCount(0);
}

const surface = (dialog: Locator) =>
  dialog.locator('[data-trn-layout="sheet"]').first();

async function openSettings(page: Page): Promise<Locator> {
  await login(page, session);
  await dark(page);
  await page.getByTestId('open-settings').click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(surface(dialog)).toBeVisible({ timeout: 15_000 });
  return dialog;
}

async function openStatus(page: Page): Promise<Locator> {
  await page.goto('/login');
  await dark(page);
  await page
    .getByRole('button', { name: 'System status', exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'System status' });
  await expect(surface(dialog)).toBeVisible({ timeout: 15_000 });
  return dialog;
}

const REACTION_KEYS = [
  '👍',
  '❤️',
  '😂',
  '😮',
  '😢',
  '🎉',
  '🚀',
  '✅',
  '👏',
  '🔥',
  '💯',
  '✨',
];

/** A room whose one message the signed-in account has reacted to with every key above. */
async function seedReactedRoom(
  request: APIRequestContext,
): Promise<{ reader: HomeserverSession; roomName: string; body: string }> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}d`;
  const user = `detents-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Detents ${runId}`;
  const body = `react to me ${runId}`;
  await registerUser(request, user, pass);
  const { token } = await apiLogin(request, hs, user, pass);
  const headers = { Authorization: `Bearer ${token}` };
  const room = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers,
    data: { name: roomName, preset: 'private_chat' },
  });
  expect(room.ok(), `create room: ${room.status()}`).toBe(true);
  const roomId = encodeURIComponent((await room.json()).room_id);
  const sent = await sendWithRetry('message', () =>
    request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/m-${runId}`,
      { headers, data: { msgtype: 'm.text', body } },
    ),
  );
  const { event_id } = await sent.json();
  for (const [index, key] of REACTION_KEYS.entries()) {
    await sendWithRetry(`reaction ${key}`, () =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.reaction/r${index}-${runId}`,
        {
          headers,
          data: {
            'm.relates_to': { rel_type: 'm.annotation', event_id, key },
          },
        },
      ),
    );
  }
  return {
    reader: { available: true, hs, user, pass } as HomeserverSession,
    roomName,
    body,
  };
}

test.describe('Sheet detents on a 390 px phone with a 47 px status bar', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use({
    ...DESIGN_VIEWPORTS['phone-pixel-5'],
    viewport: { width: 390, height: HEIGHT },
    screen: { width: 390, height: HEIGHT },
  });

  test.beforeEach(async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: TOP_INSET, bottom: 34 },
    });
  });

  test('Settings opens at half height, drags to full and back, and closes from half', async ({
    page,
  }, testInfo) => {
    const dialog = await openSettings(page);
    const sheet = surface(dialog);
    await expectMedium(sheet);
    await attach(page, testInfo, 'settings-half-390-dark');
    await dragHandle(page, sheet, -300);
    await expectLarge(sheet);
    await attach(page, testInfo, 'settings-full-390-dark');
    await dragHandle(page, sheet, 300);
    await expectMedium(sheet);
    await dragHandle(page, sheet, 300);
    await expect(dialog).toHaveCount(0);
  });

  test('focusing Settings search raises the sheet to full height, and blur keeps it', async ({
    page,
  }) => {
    const dialog = await openSettings(page);
    const sheet = surface(dialog);
    await expectMedium(sheet);
    const search = dialog
      .locator('trn-settings-directory-search input')
      .first();
    await search.focus();
    await expectLarge(sheet);
    // The field and its results stay above the keyboard; only a drag lowers the sheet.
    await search.blur();
    await expectLarge(sheet);
  });

  test('a section edge swipe changes no height, and a vertical drag swipes no section back', async ({
    page,
  }) => {
    const dialog = await openSettings(page);
    const sheet = surface(dialog);
    await expectMedium(sheet);
    await dialog.getByTestId('settings-nav-profile').click();
    await expect(page.getByTestId('display-name-input')).toBeVisible();
    await expect(page.locator('[data-pane-slide]')).toHaveCount(0);
    const workspace = dialog.getByTestId('settings-workspace');
    let box = (await workspace.boundingBox())!;

    // Mostly vertical, from the edge: the sheet grows and the section stays.
    const edge = { x: Math.round(box.x + 8), y: Math.round(box.y + 60) };
    await cdpSwipe(page, edge, { x: edge.x + 40, y: edge.y - 250 });
    await expectLarge(sheet);
    await expect(page.getByTestId('display-name-input')).toBeVisible();
    await expect(workspace).not.toHaveAttribute('data-pane-swipe');

    // Mostly horizontal, from the edge: the section goes back and the height holds.
    box = (await workspace.boundingBox())!;
    const from = { x: Math.round(box.x + 8), y: Math.round(box.y + 200) };
    await cdpSwipe(page, from, {
      x: Math.round(box.x + box.width * 0.75),
      y: from.y + 60,
    });
    await expect(dialog.getByTestId('settings-nav-profile')).toBeVisible();
    await expect(page.getByTestId('display-name-input')).toBeHidden();
    await expectLarge(sheet);
  });

  test('System status opens at half height, drags to full and back, and closes from half', async ({
    page,
  }, testInfo) => {
    const dialog = await openStatus(page);
    await expectMedium(surface(dialog));
    await attach(page, testInfo, 'system-status-half-390-dark');
    await expectDetentDrag(page, dialog);
  });

  test('the reactions list opens at half height; message actions keep their content height', async ({
    page,
    request,
  }, testInfo) => {
    const seeded = await seedReactedRoom(request);
    await login(page, seeded.reader);
    await dark(page);
    await openNamedRoom(page, seeded.roomName);
    const row = page.locator('.scroll .msg', { hasText: seeded.body }).first();
    await expect(row.locator('.reaction:not(.reaction--who)')).toHaveCount(
      REACTION_KEYS.length,
      { timeout: 30_000 },
    );

    const actions = page.getByRole('dialog', { name: 'Message actions' });
    await expect(async () => {
      if (await actions.isVisible()) return;
      await touchLongPress(page, row);
      await expect(actions).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const actionSheet = actions.locator('[data-trn-layout="sheet"]').first();
    await expect(actionSheet).toBeVisible();
    await sheetAtRest(actionSheet);
    await expect(actionSheet).not.toHaveAttribute('data-sheet-detent');
    await expect(
      actions.getByRole('button', { name: 'Sheet height' }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(actions).toHaveCount(0);

    await row.getByTestId('reactions-who').click();
    const dialog = page.getByRole('dialog').filter({
      has: page.getByTestId('reactions-dialog'),
    });
    await expect(surface(dialog)).toBeVisible({ timeout: 10_000 });
    await expectMedium(surface(dialog));
    await attach(page, testInfo, 'reactions-half-390-dark');
    await expectDetentDrag(page, dialog);
  });
});
