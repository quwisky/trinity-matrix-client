import {
  testResourceId,
  test,
  expect,
  devices,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  closeSettings,
  openSettingsFromRooms,
} from '../../../support/journeys/navigation.mts';
import { openNamedRoom } from '../../../support/message-composer.mts';
import {
  sheetAtRest,
  touchLongPress,
} from '../../../support/touch-platform.mts';
import { createRoom } from '../../support/space-journey.mts';

// The largest root scale the app allows is 250%: iOS Dynamic Type and the Text size option
// multiply, then the adapter caps the product (MAX_ROOT_PERCENT). Chromium has no Dynamic
// Type, so this forces the capped root on a phone-sized viewport and checks that every
// primary control on the main surfaces is still on screen and not clipped by an ancestor.
const session = homeserverSession();
const CAP = '250%';
const KEYBOARD = 336;

test.use({
  ...devices['Pixel 5'],
  viewport: { width: 390, height: 844 },
});

/**
 * Visible controls that a person could not reach: outside the viewport sideways, or cut off
 * by an ancestor that clips (overflow hidden/clip) rather than scrolls.
 */
async function unreachableControls(
  scope: Locator,
  selector = 'button, a[href], input, textarea, [role="button"], [role="menuitem"], [role="tab"]',
): Promise<string[]> {
  return scope.evaluate((root, sel) => {
    const out: string[] = [];
    const viewport = { width: innerWidth, height: innerHeight };
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (
        style.visibility === 'hidden' ||
        style.display === 'none' ||
        box.width === 0 ||
        box.height === 0 ||
        el.closest('.sr-only, [hidden], [inert], [aria-hidden="true"]')
      ) {
        continue;
      }
      const label =
        el.getAttribute('aria-label') ??
        el.getAttribute('data-testid') ??
        (el.textContent ?? '').trim().slice(0, 30);
      const name = `${el.tagName.toLowerCase()}[${label}]`;
      // A clip only hides a control that no scroller between them can bring back.
      let scrollsX = false;
      let scrollsY = false;
      let clipped = false;
      for (
        let parent = el.parentElement;
        parent && parent !== document.documentElement;
        parent = parent.parentElement
      ) {
        const p = getComputedStyle(parent);
        const pb = parent.getBoundingClientRect();
        const clipX = p.overflowX === 'hidden' || p.overflowX === 'clip';
        const clipY = p.overflowY === 'hidden' || p.overflowY === 'clip';
        if (
          (clipX &&
            !scrollsX &&
            (box.left < pb.left - 1 || box.right > pb.right + 1)) ||
          (clipY &&
            !scrollsY &&
            (box.top < pb.top - 1 || box.bottom > pb.bottom + 1))
        ) {
          out.push(
            `${name} clipped by ${parent.tagName.toLowerCase()}.${String(parent.className).slice(0, 40)} (${Math.round(box.left)}..${Math.round(box.right)} x ${Math.round(box.top)}..${Math.round(box.bottom)} in ${Math.round(pb.left)}..${Math.round(pb.right)} x ${Math.round(pb.top)}..${Math.round(pb.bottom)})`,
          );
          clipped = true;
          break;
        }
        scrollsX ||= p.overflowX === 'auto' || p.overflowX === 'scroll';
        scrollsY ||= p.overflowY === 'auto' || p.overflowY === 'scroll';
      }
      if (
        !clipped &&
        !scrollsX &&
        (box.left < -1 || box.right > viewport.width + 1)
      ) {
        out.push(`${name} outside viewport x ${box.left}..${box.right}`);
      }
    }
    return out;
  }, selector);
}

/** Wait out entrance animations, so controls are measured where they rest. */
async function settled(surface: Locator): Promise<void> {
  await surface.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    ),
  );
}

async function capRoot(page: Page): Promise<void> {
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = size;
  }, CAP);
}

test.describe('Largest text size on a phone', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.describe.configure({ timeout: 120_000 });

  test('keeps primary controls reachable at the capped root size', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}cap`;
    const user = `cap-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Cap ${runId}`;

    await registerUser(request, user, pass);
    const { access_token } = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());
    const headers = { Authorization: `Bearer ${access_token}` };
    const roomId = await createRoom(
      request,
      hs,
      { accessToken: access_token },
      roomName,
    );
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/c-${runId}`,
      { headers, data: { msgtype: 'm.text', body: `act on me ${runId}` } },
    );

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await capRoot(page);
    expect(
      await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      ),
    ).toBe(40);

    // The room list.
    await expect(page.getByTestId('rail-rooms')).toBeVisible();
    expect(
      await unreachableControls(page.locator('body')),
      'room list',
    ).toEqual([]);

    // An open room, with the composer and then the keyboard's space taken from the bottom.
    await openNamedRoom(page, roomName);
    const composer = page.getByTestId('composer-input');
    const row = page.locator('.msg[data-mid]').last();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-pane-slide]')).toHaveCount(0);
    expect(await unreachableControls(page.locator('body')), 'room').toEqual([]);
    // Shrinking to fit must not take a header button below a usable touch target.
    for (const id of ['back-to-rooms', 'open-threads']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.width, id).toBeGreaterThanOrEqual(44);
    }

    // The message action sheet.
    const sheet = page
      .getByRole('dialog', { name: 'Message actions' })
      .getByTestId('action-sheet-surface');
    await expect(async () => {
      if (await sheet.isVisible()) return;
      await touchLongPress(page, row);
      await expect(sheet).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await sheetAtRest(sheet);
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox!.y).toBeGreaterThanOrEqual(0);
    expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(845);
    const cancel = sheet.getByText('Cancel');
    await cancel.scrollIntoViewIfNeeded();
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox!.y + cancelBox!.height).toBeLessThanOrEqual(845);
    await cancel.click();
    await expect(sheet).toBeHidden();

    await page.evaluate((px) => {
      document.documentElement.style.setProperty(
        '--trinity-keyboard-inset',
        `${px}px`,
      );
    }, KEYBOARD);
    await expect(composer).toBeVisible();
    await expect
      .poll(
        async () => {
          const box = await composer.boundingBox();
          return box!.y + box!.height;
        },
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(844 - KEYBOARD + 1);
    const composerBox = await composer.boundingBox();
    expect(composerBox!.y).toBeGreaterThanOrEqual(0);
    expect(
      await unreachableControls(page.locator('body')),
      'room with keyboard',
    ).toEqual([]);
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('--trinity-keyboard-inset');
    });

    // Settings, as a list and as a section.
    await page.getByTestId('back-to-rooms').click();
    await openSettingsFromRooms(page);
    const nav = page.getByTestId('settings-dialog-directory');
    await expect(nav).toBeVisible();
    await settled(page.getByRole('dialog', { name: 'Settings' }));
    expect(
      await unreachableControls(page.getByRole('dialog', { name: 'Settings' })),
      'settings list',
    ).toEqual([]);
    await page.getByTestId('settings-nav-appearance').click();
    await expect(page.getByTestId('settings-detail')).not.toBeEmpty();
    await settled(page.getByRole('dialog', { name: 'Settings' }));
    expect(
      await unreachableControls(page.getByRole('dialog', { name: 'Settings' })),
      'settings section',
    ).toEqual([]);
    await closeSettings(page);
  });
});
