import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for the unread "New messages" divider + jump-to-unread pill: a reader
// whose fully-read marker sits at an old message sees a divider before the first
// unread one, and — with the divider scrolled off the top — a jump pill that brings it
// back into view. Needs a Synapse homeserver (Docker).
const session = synapseSession();

async function apiToken(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<{ userId: string; headers: { Authorization: string } }> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return {
    userId: json.user_id as string,
    headers: { Authorization: `Bearer ${json.access_token}` },
  };
}

async function sendText(
  request: APIRequestContext,
  hs: string,
  roomId: string,
  headers: { Authorization: string },
  body: string,
  txn: string,
): Promise<string> {
  const json = await request
    .put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn}`,
      { headers, data: { msgtype: 'm.text', body } },
    )
    .then((r) => r.json());
  return json.event_id as string;
}

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Unread divider + jump-to-unread', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows a divider and a jump pill for unread messages', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}u`;
    const hs = session.hs as string;

    // Seed a reader + a member who fills the room with messages.
    const readerUser = `unread-reader-${runId}`;
    const memberUser = `unread-member-${runId}`;
    await registerUser(request, readerUser, `${readerUser}-pass`);
    await registerUser(request, memberUser, `${memberUser}-pass`);
    const reader = await apiToken(
      request,
      hs,
      readerUser,
      `${readerUser}-pass`,
    );
    const member = await apiToken(
      request,
      hs,
      memberUser,
      `${memberUser}-pass`,
    );

    const roomName = `Unread E2E ${runId}`;
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: reader.headers,
        data: { name: roomName, invite: [member.userId] },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: member.headers },
    );

    // One old message the reader has read up to…
    const readEventId = await sendText(
      request,
      hs,
      roomId,
      member.headers,
      'seen already',
      `${runId}-a`,
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      {
        headers: reader.headers,
        data: { 'm.fully_read': readEventId, 'm.read': readEventId },
      },
    );

    // …then a run of unread ones (enough to overflow the short viewport below).
    for (let i = 0; i < 14; i++) {
      await sendText(
        request,
        hs,
        roomId,
        member.headers,
        `unread message ${i}`,
        `${runId}-b${i}`,
      );
    }

    // A short viewport so the divider (near the top) is scrolled off on open.
    await page.setViewportSize({ width: 1000, height: 400 });
    await login(page, {
      available: true,
      hs,
      user: readerUser,
      pass: `${readerUser}-pass`,
    } as SynapseSession);
    await openRoom(page, roomName);

    // The "New messages" divider is rendered before the first unread message.
    const divider = page.getByTestId('new-messages-divider');
    await expect(divider).toHaveText(/New messages/i, { timeout: 20_000 });

    // The divider is actually STYLED, not merely present.
    //
    // This exists because it once was not. When the markup moved into `trn-timeline-divider`
    // its rules stayed behind in the two list stylesheets, and Angular's emulated
    // encapsulation scopes rules to the component that DECLARES them — so the selectors kept
    // the lists' id, the elements carried the divider's, and every rule silently stopped
    // matching. The divider rendered as bare unstyled text on the app's main screen and the
    // whole suite stayed green, because presence and text were all anything checked.
    //
    // Computed style, in a real browser: jsdom applies no CSS, so a unit test cannot see this
    // class of bug at all. `flexGrow` on `::before` is the sharpest single probe — the rules
    // either side of the label are generated content, so if the stylesheet is not reaching
    // this element there is nothing there to measure.
    const styling = await divider.evaluate((el) => ({
      display: getComputedStyle(el).display,
      alignItems: getComputedStyle(el).alignItems,
      fontWeight: getComputedStyle(el).fontWeight,
      ruleFlexGrow: getComputedStyle(el, '::before').flexGrow,
    }));
    expect(styling).toEqual({
      display: 'flex',
      alignItems: 'center',
      fontWeight: '600',
      ruleFlexGrow: '1',
    });

    // On open the timeline pins to the bottom, so the divider is off-screen and the
    // jump pill appears; clicking it brings the divider into view and hides the pill.
    const jump = page.getByTestId('jump-to-unread');
    const scroll = page.locator('.scroll').first();
    await expect(jump).toBeVisible({ timeout: 20_000 });

    // Record what the app asks for when it scrolls itself. The jump goes through
    // `scrollIntoView`, and the behaviour it passes is the only observable difference
    // between honouring reduced motion and ignoring it — "did it animate?" is a statement
    // about frames over time, which is how a test like this goes flaky.
    await page.evaluate(() => {
      const w = window as unknown as { __scrolls: string[] };
      w.__scrolls = [];
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (
        this: Element,
        ...args: unknown[]
      ) {
        const options = args[0] as ScrollIntoViewOptions | undefined;
        if (options && typeof options === 'object' && options.behavior) {
          w.__scrolls.push(options.behavior);
        }
        return (original as (...a: unknown[]) => void).apply(this, args);
      } as typeof Element.prototype.scrollIntoView;
    });

    await jump.click();
    await expect(jump).toBeHidden({ timeout: 20_000 });

    const readScrolls = () =>
      page.evaluate(
        () => (window as unknown as { __scrolls: string[] }).__scrolls,
      );
    expect(await readScrolls()).toContain('smooth');

    // Now the same jump for a reader who asked the operating system for less motion.
    //
    // The `prefers-reduced-motion` reset in `global.scss` sets
    // `scroll-behavior: auto !important` and cannot reach this: the behaviour is passed as
    // an ARGUMENT to `scrollIntoView`, which beats any stylesheet. The app has to read the
    // media query itself, and this is the only place that path is exercised by real code —
    // every unit test in the workspace stubs `matchMedia` to `matches: false`.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await page.evaluate(
        () => matchMedia('(prefers-reduced-motion: reduce)').matches,
      ),
    ).toBe(true);

    // Back to the newest message, which puts the divider off-screen ABOVE and brings the
    // pill back. Deliberately not scrolling up by a fixed amount: that heads towards the
    // top, and crossing the auto-load threshold starts a backfill whose re-rendering leaves
    // the pill never stable enough for Playwright to click.
    await scroll.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(jump).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => {
      (window as unknown as { __scrolls: string[] }).__scrolls = [];
    });
    await jump.click();
    await expect(jump).toBeHidden({ timeout: 20_000 });

    const reduced = await readScrolls();
    expect(reduced.length).toBeGreaterThan(0);
    expect([...new Set(reduced)]).toEqual(['auto']);
  });
});
