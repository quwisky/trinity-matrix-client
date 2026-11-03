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

/** Resolves once `scroller` has had no scroll event for longer than the drag's 120ms momentum guard. */
async function scrollSettled(scroller: Locator): Promise<void> {
  await scroller.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const scrolled = () => {
          clearTimeout(quiet);
          quiet = setTimeout(() => {
            element.removeEventListener('scroll', scrolled);
            resolve();
          }, 200);
        };
        element.addEventListener('scroll', scrolled);
        scrolled();
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

/**
 * A room with one message that `reactors` accounts, the signed-in one first, reacted 👍 to.
 * The list shows one row per reactor, so this sets how tall the reactions list is.
 */
async function seedReactedRoom(
  request: APIRequestContext,
  reactors: number,
): Promise<{ reader: HomeserverSession; roomName: string; body: string }> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}d${reactors}`;
  const users = Array.from(
    { length: reactors },
    (_, i) => `detents-${runId}-${i}`,
  );
  const roomName = `Detents ${runId}`;
  const body = `react to me ${runId}`;
  const headers = await Promise.all(
    users.map(async (user) => {
      await registerUser(request, user, `${user}-pass`);
      const { token } = await apiLogin(request, hs, user, `${user}-pass`);
      return { Authorization: `Bearer ${token}` };
    }),
  );
  const room = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: headers[0],
    data: { name: roomName, preset: 'public_chat' },
  });
  expect(room.ok(), `create room: ${room.status()}`).toBe(true);
  const roomId = encodeURIComponent((await room.json()).room_id);
  for (const [index, other] of headers.slice(1).entries()) {
    await sendWithRetry(`join ${index}`, () =>
      request.post(`${hs}/_matrix/client/v3/rooms/${roomId}/join`, {
        headers: other,
      }),
    );
  }
  const sent = await sendWithRetry('message', () =>
    request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/m-${runId}`,
      { headers: headers[0], data: { msgtype: 'm.text', body } },
    ),
  );
  const { event_id } = await sent.json();
  for (const [index, reactor] of headers.entries()) {
    await sendWithRetry(`reaction ${index}`, () =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.reaction/r${index}-${runId}`,
        {
          headers: reactor,
          data: {
            'm.relates_to': { rel_type: 'm.annotation', event_id, key: '👍' },
          },
        },
      ),
    );
  }
  return {
    reader: {
      available: true,
      hs,
      user: users[0],
      pass: `${users[0]}-pass`,
    } as HomeserverSession,
    roomName,
    body,
  };
}

/** Signs in as the first reactor and opens the room, its message showing `reactors` 👍. */
async function openReactedMessage(
  page: Page,
  request: APIRequestContext,
  reactors: number,
): Promise<Locator> {
  const seeded = await seedReactedRoom(request, reactors);
  await login(page, seeded.reader);
  await dark(page);
  await openNamedRoom(page, seeded.roomName);
  const row = page.locator('.scroll .msg', { hasText: seeded.body }).first();
  await expect(
    row.locator('.reaction:not(.reaction--who) .reaction__count'),
  ).toHaveText(String(reactors), { timeout: 30_000 });
  return row;
}

async function openReactions(page: Page, row: Locator): Promise<Locator> {
  await row.getByTestId('reactions-who').click();
  const dialog = page.getByRole('dialog').filter({
    has: page.getByTestId('reactions-dialog'),
  });
  await expect(surface(dialog)).toBeVisible({ timeout: 10_000 });
  return dialog;
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
    // The field and its results stay above the keyboard; the keyboard closing never lowers it.
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

  test('in a section scrolled to one of its parts, a vertical edge drag scrolls it and a horizontal one goes back', async ({
    page,
  }) => {
    const dialog = await openSettings(page);
    const sheet = surface(dialog);
    await expectMedium(sheet);
    await dialog.getByTestId('settings-nav-appearance').click();
    await expect(dialog.getByTestId('mode-dark')).toBeVisible();
    await expect(page.locator('[data-pane-slide]')).toHaveCount(0);
    // A part chip scrolls the section part-way down to that part.
    await dialog.locator('[data-part="code-blocks"]').click();
    const detail = dialog.getByTestId('settings-detail');
    await expect
      .poll(() => detail.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(100);
    await scrollSettled(detail);
    const workspace = dialog.getByTestId('settings-workspace');
    const box = (await detail.boundingBox())!;
    const edge = {
      x: Math.round(box.x + 8),
      y: Math.round(box.y + box.height / 2),
    };

    // Mostly vertical, from the edge: the section scrolls, nothing else moves.
    const before = await detail.evaluate((el) => el.scrollTop);
    await cdpSwipe(page, edge, { x: edge.x + 30, y: edge.y + 120 });
    await expect
      .poll(() => detail.evaluate((el) => el.scrollTop))
      .toBeLessThan(before);
    await expectMedium(sheet);
    await expect(workspace).not.toHaveAttribute('data-pane-swipe');
    await expect(dialog.getByTestId('settings-nav-appearance')).toBeHidden();

    // Mostly horizontal, from the edge: the section goes back and the height holds.
    await scrollSettled(detail);
    await cdpSwipe(page, edge, {
      x: Math.round(box.x + box.width * 0.75),
      y: edge.y + 40,
    });
    await expect(dialog.getByTestId('settings-nav-appearance')).toBeVisible();
    await expectMedium(sheet);
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
    const row = await openReactedMessage(page, request, 10);

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
    // Content-sized: as tall as its rows, with nothing imposed and nothing to scroll.
    const fit = await actionSheet.evaluate((element) => {
      const body = element.querySelector<HTMLElement>('.dialog-shell__body');
      return {
        height: element.getBoundingClientRect().height,
        content: element.scrollHeight,
        inlineHeight: element.style.height,
        bodyOverflow: body ? body.scrollHeight - body.clientHeight : 0,
      };
    });
    expect(fit.inlineHeight).toBe('');
    // Under 2 px: the heights are fractional, scrollHeight is rounded.
    expect(Math.abs(fit.height - fit.content)).toBeLessThan(2);
    expect(fit.bodyOverflow).toBeLessThan(2);
    await page.keyboard.press('Escape');
    await expect(actions).toHaveCount(0);

    const dialog = await openReactions(page, row);
    await expectMedium(surface(dialog));
    await attach(page, testInfo, 'reactions-half-390-dark');
    await expectDetentDrag(page, dialog);
  });

  test('a one-reactor reactions list rests at its own height with no full height', async ({
    page,
    request,
  }) => {
    const row = await openReactedMessage(page, request, 1);
    const dialog = await openReactions(page, row);
    const sheet = surface(dialog);
    await expect(dialog.locator('.reactor')).toHaveCount(1);
    const top = await settledTop(sheet);
    expect(top).toBeGreaterThan(HEIGHT / 2 + 20);
    await expect(
      dialog.getByRole('button', { name: 'Sheet height' }),
    ).toHaveCount(0);
    await dragHandle(page, sheet, -300);
    expect(Math.abs((await settledTop(sheet)) - top)).toBeLessThanOrEqual(2);
  });
});
