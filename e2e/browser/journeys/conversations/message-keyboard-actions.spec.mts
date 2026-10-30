import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Message actions for keyboard users, and the lazy toolbar behind them (#958).
//
// Each action-capable message is ONE tab stop. Focusing it mounts and shows its toolbar, and
// Tab moves into the toolbar's buttons. The toolbar used to be mounted, invisible, on every
// row, so tabbing through a long room visited four hidden buttons per message, and the hidden
// toolbars were most of the timeline's DOM. Needs a Synapse homeserver (Docker).
const session = homeserverSession();
const SEED = 60;
/**
 * The app's `initialSyncLimit` (`startClient` in
 * `libs/data-access/matrix-client/src/lib/js-sdk/matrix-client.service.ts`): the timeline page the
 * first /sync delivers.
 */
const INITIAL_SYNC_PAGE = 20;

test.describe('Message actions from the keyboard', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a long room has one tab stop per message, and Tab reaches its actions', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}kb`;
    const me = `kb-me-${runId}`;
    const mePass = `${me}-pass`;
    const roomName = `Keyboard ${runId}`;

    await registerUser(request, me, mePass);
    const headers = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: me },
          password: mePass,
        },
      })
      .then((r) => r.json())
      .then((j) => ({ Authorization: `Bearer ${j.access_token}` }));
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    for (let i = 0; i < SEED; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-${i}`,
        { headers, data: { msgtype: 'm.text', body: `keyboard message ${i}` } },
      );
    }

    await login(page, {
      available: true,
      hs,
      user: me,
      pass: mePass,
    } as HomeserverSession);
    await page.getByTestId('rail-rooms').click();
    await page.locator('.channel', { hasText: roomName }).first().click();
    const timeline = page.locator('.scroll');
    await expect(
      timeline.locator('.msg__text', {
        hasText: `keyboard message ${SEED - 1}`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    // Keep the pointer off the timeline so no row is hovered.
    await page.getByTestId('composer-input').hover();

    // Every mounted message row is a tab stop, and none carries hidden toolbar buttons.
    // The initial sync brings only the newest INITIAL_SYNC_PAGE messages; the timeline pages
    // in older history after that. Wait until those rows are mounted too, so the check
    // covers paged-in history and not just the first page. Read every row's tabindex in one
    // DOM snapshot, so rows that arrive during the read cannot skew the comparison.
    const messages = timeline.locator('.msg:has(.msg__text)');
    const readTabIndexes = () =>
      messages.evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('tabindex')),
      );
    let tabIndexes: (string | null)[] = [];
    await expect
      .poll(
        async () => {
          tabIndexes = await readTabIndexes();
          return tabIndexes.length;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(INITIAL_SYNC_PAGE);
    expect(tabIndexes.filter((tabIndex) => tabIndex !== '0')).toEqual([]);
    await expect(timeline.locator('trn-message-toolbar')).toHaveCount(0);
    await expect(timeline.locator('.toolbar__btn')).toHaveCount(0);

    // Shift+Tab from a message lands on the message above, not on four hidden buttons.
    const rowFor = (i: number) =>
      timeline.locator('.msg', {
        has: page.locator('.msg__text', {
          hasText: new RegExp(`^keyboard message ${i}$`),
        }),
      });
    const last = rowFor(SEED - 1);
    const previous = rowFor(SEED - 2);
    // A key press first, as a keyboard user's would be: Chromium shows `:focus-visible` for
    // programmatic focus only after keyboard input, not after the mouse click that opened
    // the room.
    await page.keyboard.press('Shift');
    await last.focus();
    await expect(last).toBeFocused();
    await expect(last.locator('.msg__toolbar')).toHaveCSS('opacity', '1');
    await page.keyboard.press('Shift+Tab');
    await expect(previous).toBeFocused();
    await expect(previous.locator('.msg__toolbar')).toHaveCSS('opacity', '1');
    // Only the focused row's toolbar is mounted.
    await expect(timeline.locator('trn-message-toolbar')).toHaveCount(1);
    await expect(last.locator('trn-message-toolbar')).toHaveCount(0);
    const ring = await previous.evaluate(
      (row) => getComputedStyle(row).outlineStyle,
    );
    expect(ring).not.toBe('none');

    // Tab moves into the focused message's toolbar; Reply is the second button.
    await page.keyboard.press('Tab');
    await expect(
      previous.getByRole('button', { name: 'Add reaction' }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    const reply = previous.getByRole('button', { name: 'Reply', exact: true });
    await expect(reply).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.composer__banner')).toContainText(
      'Replying to',
      { timeout: 10_000 },
    );

    // Shift+F10 on a focused message opens its action menu.
    const menuRow = rowFor(SEED - 3);
    await menuRow.focus();
    await expect(menuRow).toBeFocused();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByTestId('msg-copy')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('msg-copy')).toHaveCount(0);
    await expect(timeline.locator('trn-message-toolbar')).toHaveCount(1);
  });
});
