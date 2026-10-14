import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '../../../fixtures.mts';
import { homeserverSession, seedPreference } from '../../../support/app.mts';
import { nextTestResourceId } from '../../../support/namespace.mts';
import { sendWithRetry } from '../../support/cs-api.mts';
import {
  addRoom,
  openRoom,
  seedFormattedRoom,
  sendMessage,
  signInAndOpen,
  uploadPng,
  type FormattedRoom,
} from '../../support/formatted-message-journey.mts';

// Show more (spec C): long bodies collapse to 20 lines behind a button, a 21–24-line body is
// shown whole, and the expanded state lasts while the room is open — across the virtual
// timeline letting a row go and bringing it back — and is reset when the room is left. A body
// that grows past the limit after an image loads or maths renders gains the button, keyboard
// focus inside a collapsed body shows it whole (a mouse click on a link does not), a jumped-to
// message opens expanded with its top in view, and the thread view behaves like the timeline.
// Never logs tokens, user ids or message bodies.
const session = homeserverSession();

const lines = (count: number, label: string): string =>
  Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join('\n');

/** The row of the message whose text contains `marker`. */
const rowWith = (page: Page, marker: string): Locator =>
  page.locator('.scroll .msg[data-mid]', { hasText: marker });

async function lineHeight(body: Locator): Promise<number> {
  return body.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  );
}

async function scrollTimelineTo(
  page: Page,
  edge: 'top' | 'bottom',
): Promise<void> {
  await page.locator('.scroll').evaluate((element, where) => {
    element.scrollTop = where === 'top' ? 0 : element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  }, edge);
}

/** The clamp's height without the ring-sized block padding it takes back with a margin. */
async function clampContentHeight(clamp: Locator): Promise<number> {
  return clamp.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      element.getBoundingClientRect().height -
      Number.parseFloat(style.paddingTop) -
      Number.parseFloat(style.paddingBottom)
    );
  });
}

/** Whether the row's top edge lies inside its scroller's visible area. */
async function topInView(row: Locator): Promise<boolean> {
  return row.evaluate((element) => {
    const scroller = element.closest('[data-message-scroller]');
    if (!scroller) return false;
    const top = element.getBoundingClientRect().top;
    const view = scroller.getBoundingClientRect();
    return top >= view.top - 1 && top < view.bottom;
  });
}

/**
 * The focused element's outline, and whether the whole ring (outline width plus offset) lies
 * inside the nearest clamp wrapper's box, which is where `overflow: clip` would cut it.
 */
async function focusRing(
  target: Locator,
): Promise<{ style: string; width: number; insideClamp: boolean }> {
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    const ring =
      Number.parseFloat(style.outlineWidth) +
      Number.parseFloat(style.outlineOffset);
    const box = element.getBoundingClientRect();
    const clamp = element.closest('.msg__clamp')?.getBoundingClientRect();
    return {
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
      insideClamp:
        !!clamp &&
        box.top - ring >= clamp.top - 0.5 &&
        box.bottom + ring <= clamp.bottom + 0.5,
    };
  });
}

/** Lines of HTML text, one `<br>` apart, inside one paragraph. */
const htmlLines = (count: number, label: string): string =>
  Array.from({ length: count }, (_, i) => `${label} line ${i + 1}`).join(
    '<br>',
  );

/** Reply in the thread under `rootId`; resolves the reply's event id. */
async function sendThreadReply(
  request: APIRequestContext,
  hs: string,
  room: FormattedRoom,
  rootId: string,
  body: string,
): Promise<string> {
  const response = await sendWithRetry('send thread reply', () =>
    request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/send/m.room.message/${nextTestResourceId('txn')}`,
      {
        headers: { Authorization: `Bearer ${room.account.accessToken}` },
        data: {
          msgtype: 'm.text',
          body,
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: rootId,
            is_falling_back: true,
            'm.in_reply_to': { event_id: rootId },
          },
        },
      },
    ),
  );
  return ((await response.json()) as { event_id: string }).event_id;
}

/**
 * Hold every request matching `url` until `release()`, which lets the held ones and any later
 * ones through. Resolves the number held so far through `count()`.
 */
async function holdRequests(
  page: Page,
  url: RegExp,
): Promise<{ count: () => number; release: () => Promise<void> }> {
  const held: Route[] = [];
  let released = false;
  await page.route(url, async (route) => {
    if (released) await route.continue();
    else held.push(route);
  });
  return {
    count: () => held.length,
    release: async () => {
      released = true;
      for (const route of held.splice(0)) await route.continue();
    },
  };
}

// The maths chunk the dev build emits; held to keep a formula in its one-line fallback.
const MATHS_CHUNK = /\/maths-render-[A-Za-z0-9]+\.js(?:\?|$)/;

test.describe('Show more on long messages', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('collapses a long message, toggles it by keyboard and keeps a 22-line message whole', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more');
    await sendMessage(request, hs, room, { body: lines(40, 'long') });
    await sendMessage(request, hs, room, { body: lines(22, 'medium') });
    await signInAndOpen(page, room);

    const medium = rowWith(page, 'medium line 1');
    await expect(medium).toBeVisible({ timeout: 20_000 });
    await expect(medium.getByTestId('msg-show-more')).toHaveCount(0);
    const mediumHeight =
      (await medium.locator('.msg__clamp').boundingBox())?.height ?? 0;
    expect(mediumHeight).toBeGreaterThanOrEqual(
      22 * (await lineHeight(medium.locator('.msg__text'))) - 1,
    );

    const long = rowWith(page, 'long line 1');
    const button = long.getByTestId('msg-show-more');
    const clamp = long.locator('.msg__clamp');
    await expect(button).toHaveText('Show more', { timeout: 20_000 });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toHaveAttribute(
      'aria-controls',
      (await clamp.getAttribute('id')) ?? '',
    );
    const lh = await lineHeight(long.locator('.msg__text'));
    expect(await clampContentHeight(clamp)).toBeLessThanOrEqual(20 * lh + 1);
    // Collapsed text stays readable to assistive technology, copies and find-in-page.
    await expect(long.locator('.msg__text')).toContainText('long line 40');

    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(button).toHaveText('Show less');
    await expect(button).toBeFocused();
    await expect
      .poll(async () => (await clamp.boundingBox())?.height ?? 0, {
        timeout: 15_000,
      })
      .toBeGreaterThan(24 * lh);

    await page.keyboard.press('Space');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toHaveText('Show more');
    await expect(button).toBeFocused();
  });

  // Review Focus 4: expanding the newest message while the list is pinned to the bottom.
  test('keeps Show less on screen after expanding the newest message at the bottom', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more-newest');
    await sendMessage(request, hs, room, { body: lines(60, 'newest') });
    await signInAndOpen(page, room);

    const button = rowWith(page, 'newest line 1').getByTestId('msg-show-more');
    await expect(button).toBeVisible({ timeout: 20_000 });
    await button.click();

    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(button).toBeInViewport({ timeout: 15_000 });
  });

  for (const windowed of [true, false]) {
    test(`keeps a message expanded after scrolling away and back ${windowed ? 'with' : 'without'} the virtual timeline`, async ({
      page,
      request,
    }) => {
      test.slow();
      const hs = session.hs as string;
      const room = await seedFormattedRoom(
        request,
        hs,
        windowed ? 'show-more-vt' : 'show-more-flat',
      );
      await sendMessage(request, hs, room, { body: lines(40, 'kept') });
      for (let i = 0; i < 100; i += 1) {
        await sendMessage(request, hs, room, { body: `filler ${i}` });
      }
      await seedPreference(
        page,
        'trinity.flags.virtual-timeline',
        String(windowed),
      );
      await signInAndOpen(page, room);
      const newest = page
        .locator('.scroll')
        .getByText('filler 99', { exact: true });
      await expect(newest).toBeVisible({ timeout: 30_000 });

      const kept = rowWith(page, 'kept line 1');
      await expect
        .poll(
          async () => {
            await scrollTimelineTo(page, 'top');
            return kept.count();
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .toBeGreaterThan(0);
      const button = kept.getByTestId('msg-show-more');
      await button.click();
      await expect(button).toHaveAttribute('aria-expanded', 'true');

      await scrollTimelineTo(page, 'bottom');
      await expect(newest).toBeInViewport({ timeout: 15_000 });
      if (windowed) {
        // The virtual timeline let the row go; the store keeps its state.
        await expect(kept).toHaveCount(0, { timeout: 15_000 });
      }

      await expect
        .poll(
          async () => {
            await scrollTimelineTo(page, 'top');
            return kept.count();
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBeGreaterThan(0);
      await expect(kept.getByTestId('msg-show-more')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });
  }

  test('collapses again after leaving the room and coming back', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more-leave');
    const otherName = `show-more-other ${testResourceId('other')}`;
    await addRoom(request, hs, room, otherName);
    await sendMessage(request, hs, room, { body: lines(40, 'leave') });
    await signInAndOpen(page, room);

    const button = rowWith(page, 'leave line 1').getByTestId('msg-show-more');
    await button.click({ timeout: 20_000 });
    await expect(button).toHaveAttribute('aria-expanded', 'true');

    await openRoom(page, otherName);
    await openRoom(page, room.roomName);

    await expect(
      rowWith(page, 'leave line 1').getByTestId('msg-show-more'),
    ).toHaveAttribute('aria-expanded', 'false', { timeout: 20_000 });
  });

  // A jump target opens expanded, and a target taller than the list is aligned by its top.
  test('lands on a search hit in a long message already expanded with its top in view', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more-search');
    const needle = `needle${testResourceId('needle').replace(/[^a-z0-9]/gi, '')}`;
    await sendMessage(request, hs, room, {
      body: `${lines(60, 'searched')}\n${needle}`,
    });
    for (let i = 0; i < 10; i += 1) {
      await sendMessage(request, hs, room, { body: `after ${i}` });
    }
    await signInAndOpen(page, room);
    await expect(
      page.locator('.scroll').getByText('after 9', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.getByTestId('header-search')).toBeFocused({
      timeout: 15_000,
    });
    await page.keyboard.type(needle);
    const result = page.getByTestId('result').first();
    await expect(result).toBeVisible({ timeout: 30_000 });
    await result.click();

    const searched = rowWith(page, 'searched line 1');
    await expect(searched.getByTestId('msg-show-more')).toHaveAttribute(
      'aria-expanded',
      'true',
      { timeout: 20_000 },
    );
    // Taller than the list, so centring it would hide its start (T21-2).
    const tallerThanList = await searched.evaluate(
      (element) =>
        element.getBoundingClientRect().height >
        (element.closest('[data-message-scroller]')?.clientHeight ?? Infinity),
    );
    expect(tallerThanList).toBe(true);
    await expect
      .poll(() => topInView(searched), { timeout: 15_000 })
      .toBe(true);
  });

  test('gains Show more when an inline image loads late and pushes the body past the limit', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more-image');
    // No sender size, so the loading box is small until the 300px-tall thumbnail arrives.
    const mxc = await uploadPng(request, hs, room, 600, 900, 'late.png');
    await sendMessage(request, hs, room, {
      body: 'a body that grows when its image loads',
      html: `<p>${htmlLines(16, 'grown')}</p><img src="${mxc}" alt="A late test image">`,
    });
    const thumbnails = await holdRequests(page, /\/thumbnail\//);
    await signInAndOpen(page, room);

    const row = rowWith(page, 'grown line 1');
    const image = row.locator('img.mx-image');
    await expect(image).toHaveClass(/mx-image--loading/, { timeout: 20_000 });
    await expect.poll(thumbnails.count, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(row.getByTestId('msg-show-more')).toHaveCount(0);

    await thumbnails.release();
    await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 30_000 });
    await expect(row.getByTestId('msg-show-more')).toHaveAttribute(
      'aria-expanded',
      'false',
      { timeout: 15_000 },
    );
  });

  test('gains Show more when maths renders taller than its source', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more-maths');
    // A 14-row column: one line of source, about 14 lines once KaTeX lays it out.
    const tex = `\\begin{matrix}${Array.from({ length: 14 }, (_, i) => `${i + 1}`).join('\\\\')}\\end{matrix}`;
    await sendMessage(request, hs, room, {
      body: 'a body that grows when its maths renders',
      html: `<p>${htmlLines(16, 'formula')}</p><div data-mx-maths="${tex}"><code>${tex}</code></div>`,
    });
    const chunk = await holdRequests(page, MATHS_CHUNK);
    await signInAndOpen(page, room);

    const row = rowWith(page, 'formula line 1');
    // The sender's fallback shows until KaTeX loads.
    await expect(row.locator('div.mx-maths > code')).toBeVisible({
      timeout: 20_000,
    });
    await expect.poll(chunk.count, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect(row.getByTestId('msg-show-more')).toHaveCount(0);

    await chunk.release();
    await expect(row.locator('div.mx-maths .katex-display')).toBeAttached({
      timeout: 30_000,
    });
    await expect(row.getByTestId('msg-show-more')).toHaveAttribute(
      'aria-expanded',
      'false',
      { timeout: 15_000 },
    );
  });

  test('follows a mouse click on a link in a collapsed body and shows the body whole for keyboard focus', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more-focus');
    // An http(s) page on the harness itself, so the popup needs no internet.
    const external = `${hs}/_matrix/client/versions`;
    const body = Array.from({ length: 40 }, (_, i) =>
      i === 1
        ? `focus line 2 <a href="${external}">an early link</a>`
        : i === 29
          ? `focus line 30 <a href="${external}">a late link</a>`
          : `focus line ${i + 1}`,
    ).join('<br>');
    await sendMessage(request, hs, room, {
      body: 'a long body with two links',
      html: `<p>${body}</p>`,
    });
    await signInAndOpen(page, room);

    const row = rowWith(page, 'focus line 1');
    const button = row.getByTestId('msg-show-more');
    await expect(button).toHaveAttribute('aria-expanded', 'false', {
      timeout: 20_000,
    });

    // A mouse press focuses the link without :focus-visible: the body stays collapsed, so
    // nothing moves under the pointer and the click lands.
    const early = row.locator('a', { hasText: 'an early link' });
    const popupEvent = page.waitForEvent('popup', { timeout: 15_000 });
    await early.click();
    const popup = await popupEvent;
    await popup.close();
    await expect(button).toHaveAttribute('aria-expanded', 'false');

    // Shift+Tab from Show more reaches the link behind the fade, which shows the body whole.
    const late = row.locator('a', { hasText: 'a late link' });
    await button.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(late).toBeFocused();
    await expect(button).toHaveAttribute('aria-expanded', 'true', {
      timeout: 15_000,
    });
    await expect(late).toBeInViewport({ timeout: 15_000 });
    const ring = await focusRing(late);
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThan(0);
  });

  test('keeps whole the focus rings of links on the first and last lines of a shown body', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more-edge');
    const external = `${hs}/_matrix/client/versions`;
    const body = Array.from({ length: 22 }, (_, i) =>
      i === 0
        ? `<a href="${external}">a first-line link</a>`
        : i === 21
          ? `<a href="${external}">a last-line link</a>`
          : `edge line ${i + 1}`,
    ).join('<br>');
    await sendMessage(request, hs, room, {
      body: 'a 22-line body with links on its edges',
      html: `<p>${body}</p>`,
    });
    await signInAndOpen(page, room);

    const row = rowWith(page, 'edge line 2');
    const first = row.locator('a', { hasText: 'a first-line link' });
    const last = row.locator('a', { hasText: 'a last-line link' });
    await expect(last).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('.msg__clamp--capped')).toHaveCount(1);
    await expect(row.getByTestId('msg-show-more')).toHaveCount(0);

    await first.focus();
    await page.keyboard.press('Tab');
    await expect(last).toBeFocused();
    const lastRing = await focusRing(last);
    expect(lastRing.style).not.toBe('none');
    expect(lastRing.insideClamp).toBe(true);

    await page.keyboard.press('Shift+Tab');
    await expect(first).toBeFocused();
    const firstRing = await focusRing(first);
    expect(firstRing.style).not.toBe('none');
    expect(firstRing.insideClamp).toBe(true);
  });

  test('collapses and expands a long reply in the thread view', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'show-more-thread');
    const rootId = await sendMessage(request, hs, room, {
      body: 'a thread root',
    });
    await sendThreadReply(request, hs, room, rootId, lines(40, 'threaded'));
    await signInAndOpen(page, room);

    const root = page.locator('.scroll .msg[data-mid]', {
      hasText: 'a thread root',
    });
    await root.getByTestId('message-thread-summary').click({ timeout: 20_000 });
    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible({ timeout: 15_000 });

    const reply = thread.locator('.msg[data-mid]', {
      hasText: 'threaded line 1',
    });
    const button = reply.getByTestId('msg-show-more');
    const clamp = reply.locator('.msg__clamp');
    await expect(button).toHaveAttribute('aria-expanded', 'false', {
      timeout: 20_000,
    });
    const lh = await lineHeight(reply.locator('.msg__text'));
    expect(await clampContentHeight(clamp)).toBeLessThanOrEqual(20 * lh + 1);

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect
      .poll(async () => (await clamp.boundingBox())?.height ?? 0, {
        timeout: 15_000,
      })
      .toBeGreaterThan(24 * lh);
  });
});
