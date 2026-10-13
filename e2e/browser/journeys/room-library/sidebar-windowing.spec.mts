import { testResourceId, test, expect } from '../../../fixtures.mts';
import { login, homeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// The room sidebar windows a long list (#1312): with enough rooms, only the rows near its
// viewport are in the DOM, between two spacers, so a large account does not carry every
// row through each room switch's style pass. These checks are the real-browser half the
// unit tests cannot do (jsdom has no layout): the DOM stays bounded, scrolling reaches every
// room, a room far down still opens, and the filter still finds a room below the window.
//
// Needs a homeserver (Docker) and self-skips otherwise.
const session = homeserverSession();
const ROOMS = 120;
/** Far below the room count, comfortably above a viewport plus overscan of rows. */
const MAX_RENDERED = 80;

test.describe('Room sidebar windowing', () => {
  test.skip(!session.available, 'needs a homeserver (Docker)');

  test('keeps a long room list bounded while every room stays reachable', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}w`;
    const user = `window-${runId}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const names: string[] = [];
    for (let i = 0; i < ROOMS; i++) {
      const name = `Window ${runId} ${String(i).padStart(3, '0')}`;
      names.push(name);
      const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name, preset: 'private_chat' },
      });
      expect(created.ok(), `create ${name}`).toBe(true);
    }

    await login(page, { available: true, hs, user, pass });
    await page.getByTestId('rail-rooms').click();
    const scroller = page.locator('.sidebar__scroll');
    const rows = scroller.locator('.channel__name');
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });

    // Every room has synced into the list, but only a window of rows is rendered.
    const filter = page.getByTestId('sidebar-filter');
    await filter.fill(`Window ${runId}`);
    await expect(page.getByTestId('sidebar-filter-status')).toContainText(
      `${ROOMS}`,
      { timeout: 60_000 },
    );
    await filter.fill('');
    expect(await rows.count()).toBeLessThan(MAX_RENDERED);

    // Scrolling through the list reaches every room, in steps smaller than the window.
    const seen = new Set<string>();
    for (let step = 0; step < 200; step++) {
      for (const name of await rows.allTextContents()) seen.add(name.trim());
      const atEnd = await scroller.evaluate((el) => {
        const end = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        el.scrollTop += el.clientHeight / 2;
        return end;
      });
      expect(await rows.count()).toBeLessThan(MAX_RENDERED);
      if (atEnd) break;
      await page.waitForTimeout(50);
    }
    for (const name of names) expect(seen, name).toContain(name);

    // A room far down the list still opens from its row.
    const far = scroller.locator('.channel', { hasText: names[0] });
    await far.scrollIntoViewIfNeeded();
    await far.click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 20_000,
    });

    // Back at the top, the filter still finds a room that is outside the window.
    await scroller.evaluate((el) => (el.scrollTop = 0));
    await filter.fill(names[1]);
    await expect(rows).toHaveText([names[1]]);
  });
});
