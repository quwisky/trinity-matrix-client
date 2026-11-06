import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import { homeserverSession, login } from '../../../support/app.mts';
import {
  apiLogin,
  registerUser,
  type ApiUser,
} from '../../../support/account.mts';
import { createRoom } from '../../support/space-journey.mts';

// New live messages slide in once (`msg-enter` on the row host). jsdom has no animation
// and no real list, so the count of class additions is measured in a real browser.
const session = homeserverSession();
const HISTORY = 120;
const LONG_BODY = 'lorem ipsum dolor sit amet '.repeat(12);

interface Seeded {
  readonly hs: string;
  readonly reader: ApiUser;
  readonly other: ApiUser;
  readonly roomId: string;
  readonly roomName: string;
}

async function seed(
  request: APIRequestContext,
  history: number,
): Promise<Seeded> {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}e`;
  await registerUser(request, `enter-a-${runId}`, 'pass-a');
  await registerUser(request, `enter-b-${runId}`, 'pass-b');
  const reader = await apiLogin(request, hs, `enter-a-${runId}`, 'pass-a');
  const other = await apiLogin(request, hs, `enter-b-${runId}`, 'pass-b');
  const roomName = `Entrance ${runId}`;
  const roomId = await createRoom(request, hs, reader, roomName, {
    invite: [other.userId],
  });
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: other.headers },
  );
  for (let i = 0; i < history; i++) {
    await say(request, hs, roomId, other, `History ${i} ${LONG_BODY}`, i);
  }
  return { hs, reader, other, roomId, roomName };
}

async function say(
  request: APIRequestContext,
  hs: string,
  roomId: string,
  who: ApiUser,
  body: string,
  n: number,
): Promise<void> {
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${testResourceId('txn')}-${n}`,
    { headers: who.headers, data: { msgtype: 'm.text', body } },
  );
}

async function open(page: Page, s: Seeded): Promise<void> {
  await login(page, {
    available: true,
    hs: s.hs,
    user: s.reader.userId.split(':')[0].slice(1),
    pass: 'pass-a',
  });
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: s.roomName }).first();
  await channel.waitFor({ state: 'visible', timeout: 30_000 });
  await channel.click();
  await page.getByTestId('composer-input').waitFor({ timeout: 30_000 });
  await expect
    .poll(() =>
      page
        .locator('.scroll')
        .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
    )
    .toBeLessThan(50);
}

/**
 * Count `msg-enter` additions per row element, from the first paint of every page load.
 * Also tags, in the page, the first row inserted whose text holds `window.__tagText`, so a
 * later remount of that row shows as a missing tag.
 */
async function watchEntrances(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __entrances: Map<Element, number>;
      __tagText?: string;
    };
    const counts = new Map<Element, number>();
    w.__entrances = counts;
    const bump = (el: Element): void => {
      counts.set(el, (counts.get(el) ?? 0) + 1);
    };
    let tagged = false;
    new MutationObserver((records) => {
      // An element inserted and classed in one batch is one entrance, not two.
      const inserted = new Set<Element>();
      for (const r of records) {
        r.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          const rows = [
            ...(n.matches('trn-message-row') ? [n] : []),
            ...n.querySelectorAll('trn-message-row'),
          ];
          for (const el of rows) {
            if (el.classList.contains('msg-enter')) inserted.add(el);
            if (
              !tagged &&
              w.__tagText &&
              el.textContent?.includes(w.__tagText)
            ) {
              (el as Element & { __tag?: number }).__tag = 1;
              tagged = true;
            }
          }
        });
      }
      inserted.forEach(bump);
      for (const r of records) {
        const el = r.target as Element;
        const had = (r.oldValue ?? '').split(' ').includes('msg-enter');
        if (
          r.type === 'attributes' &&
          el.tagName === 'TRN-MESSAGE-ROW' &&
          !had &&
          el.classList.contains('msg-enter') &&
          !inserted.has(el)
        )
          bump(el);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    });
  });
}

/** Entrances so far on rows showing `text`; every row when `text` is omitted. */
const entrances = (page: Page, text?: string): Promise<number> =>
  page.evaluate((t) => {
    const counts = (window as unknown as { __entrances: Map<Element, number> })
      .__entrances;
    let total = 0;
    counts.forEach((n, el) => {
      if (!t || el.textContent?.includes(t)) total += n;
    });
    return total;
  }, text);

async function send(page: Page, body: string): Promise<void> {
  const field = page.getByTestId('composer-input');
  await field.click();
  await field.fill(body);
  await field.press('Enter');
}

test.describe('New-message entrance', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('animates a sent message once and keeps its element through the echo', async ({
    page,
    request,
  }) => {
    const s = await seed(request, 3);
    await watchEntrances(page);
    await open(page, s);

    const body = `sent ${testResourceId('msg')}`;
    await page.evaluate((t) => {
      (window as unknown as { __tagText: string }).__tagText = t;
    }, body);
    await send(page, body);
    const row = page.locator('trn-message-row', { hasText: body });
    // The element tagged when it was first inserted must be the one the echo lands on.
    await expect
      .poll(() => row.locator('.msg[data-mid]').getAttribute('data-mid'), {
        timeout: 30_000,
      })
      .toMatch(/^\$/);
    expect(
      await row.evaluate(
        (el) => (el as HTMLElement & { __tag?: number }).__tag,
      ),
    ).toBe(1);

    expect(await entrances(page, body)).toBe(1);
    // The class is a temporary mark: it is gone once the entrance has played.
    await expect(row).not.toHaveClass(/msg-enter/);
  });

  test('animates a received message at the bottom once', async ({
    page,
    request,
  }) => {
    const s = await seed(request, 3);
    await watchEntrances(page);
    await open(page, s);

    const body = `received ${testResourceId('msg')}`;
    await say(request, s.hs, s.roomId, s.other, body, 99);
    await expect(
      page.locator('trn-message-row', { hasText: body }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(600);
    expect(await entrances(page, body)).toBe(1);
  });

  test('does not animate on room open or older history', async ({
    page,
    request,
  }) => {
    const s = await seed(request, HISTORY);
    await watchEntrances(page);
    await open(page, s);

    // The first page holds the newest messages only; the oldest must arrive by paginating.
    const oldest = page.locator('trn-message-row', { hasText: 'History 0 ' });
    await expect(oldest).toHaveCount(0);
    const scroll = page.locator('.scroll');
    const paged = page.waitForRequest(/\/messages\?.*dir=b/);
    await expect
      .poll(
        async () => {
          await scroll.evaluate((el) => (el.scrollTop = 0));
          return oldest.count();
        },
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);
    await paged;
    await page.waitForTimeout(600);
    expect(await entrances(page)).toBe(0);
  });

  test.describe('with reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('does not animate a sent message', async ({ page, request }) => {
      const s = await seed(request, 3);
      await watchEntrances(page);
      await open(page, s);

      const body = `still ${testResourceId('msg')}`;
      await send(page, body);
      await expect(
        page.locator('trn-message-row', { hasText: body }),
      ).toBeVisible();
      await page.waitForTimeout(600);
      expect(await entrances(page)).toBe(0);
    });
  });
});
