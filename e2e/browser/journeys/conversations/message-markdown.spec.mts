import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Route,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  waitForSent,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';
import {
  addRoom,
  openRoom,
  seedFormattedRoom,
  sendMessage,
  signInAndOpen,
  uploadPng,
} from '../../support/formatted-message-journey.mts';

// Covers the markdown render path end to end, through the REAL composer so the wire
// format is exercised, not just the rendering:
//   - a soft line break survives alongside formatting (issue #29's sharpest bug)
//   - a plain multi-line message still goes as plain text, not formatted_body
//   - task lists arrive as ☑/☐ rather than being silently dropped
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = homeserverSession();

/** Every message event in the room, oldest first, straight from the homeserver. */
async function roomEvents(
  request: APIRequestContext,
  hs: string,
  token: string,
  roomId: string,
): Promise<Record<string, never>[]> {
  const json = await request
    .get(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(
        roomId,
      )}/messages?dir=b&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    .then((r) => r.json());
  return (json.chunk as Record<string, never>[])
    .filter((e) => (e as Record<string, unknown>)['type'] === 'm.room.message')
    .reverse();
}

test.describe('Message markdown', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('renders formatting, keeps line breaks, and only sends HTML when it means something', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}md`;
    const user = `md-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Markdown ${runId}`;

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
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openNamedRoom(page, roomName);

    // 1. A plain multi-line message.
    await sendComposerLines(page, ['plain one', 'plain two']);
    await expect(
      page.locator('.msg__text', { hasText: 'plain one' }),
    ).toBeVisible({ timeout: 20_000 });

    // 2. The same shape, but with formatting — this is the bug: before the fix the
    //    line break vanished the moment anything was bold.
    await sendComposerLines(page, ['**bold one**', 'rich two']);
    const rich = page.locator('.msg__text--html', { hasText: 'rich two' });
    await expect(rich).toBeVisible({ timeout: 20_000 });
    await expect(rich.locator('strong')).toHaveText('bold one');
    await expect(rich.locator('br')).toHaveCount(1);

    // Both rows render from the local echo, which the homeserver has not necessarily
    // seen yet — so wait for the real event id before asking it what we sent, or
    // /messages can come back with only the first message.
    for (const text of ['plain one', 'rich two']) {
      await waitForSent(
        page.locator('.scroll .msg[data-mid]', { hasText: text }).first(),
      );
    }

    // The wire format is the real assertion: markdown that adds nothing must NOT be
    // promoted to HTML just because `breaks` turns newlines into <br>.
    const events = await roomEvents(request, hs, token, roomId);
    const [plain, formatted] = events as unknown as {
      content: { body: string; format?: string; formatted_body?: string };
    }[];

    expect(plain.content.body).toBe('plain one\nplain two');
    expect(plain.content.format).toBeUndefined();
    expect(plain.content.formatted_body).toBeUndefined();

    expect(formatted.content.format).toBe('org.matrix.custom.html');
    expect(formatted.content.formatted_body).toContain('<br>');
    expect(formatted.content.formatted_body).toContain(
      '<strong>bold one</strong>',
    );
    // `body` keeps the author's source, so editing round-trips the markdown.
    expect(formatted.content.body).toBe('**bold one**\nrich two');
  });

  test('renders a task list as glyphs rather than dropping it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}tl`;
    const user = `task-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Tasks ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openNamedRoom(page, roomName);

    // Only the first marker is typed. Shift+Enter carries the whole marker onto the next
    // line — bullet AND task box, always unticked — so the second line is just its text.
    // Typing `- ` again would nest a second list; typing `[ ] ` again would put a literal
    // `[ ]` inside the item, which is what this spec caught when the box started carrying.
    await sendComposerLines(page, ['- [x] shipped', 'pending']);

    const list = page.locator('.msg__text--html', { hasText: 'shipped' });
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(list).toContainText('☑ shipped');
    await expect(list).toContainText('☐ pending');
    // The checkbox was previously stripped on the way out, taking the state with it.
    await expect(list.locator('input')).toHaveCount(0);
  });

  test('keeps the language caption clear of the hover toolbar', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}ov`;
    const user = `ov-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Overlap ${runId}`;

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
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as HomeserverSession);
    await openNamedRoom(page, roomName);

    // A leading message makes the block a CONTINUATION row — no author header to push it
    // down, which is where the row's hover toolbar sits lowest over it. Hovering the block
    // necessarily hovers the message, so the two are always shown together.
    await sendComposerLines(page, ['setting up']);
    await page.waitForTimeout(500);
    await sendComposerLines(page, ['```python', 'x = 1', '```']);

    const pre = page.locator('.msg__text--html pre').first();
    await expect(pre).toBeVisible({ timeout: 20_000 });
    await waitForSent(
      page.locator('.scroll .msg[data-mid]', { hasText: 'x = 1' }).first(),
    );
    const row = page.locator('.msg', { has: pre }).first();
    await expect(row).toHaveClass(/msg--cont/);

    await pre.hover();
    await expect(row.locator('.msg__toolbar')).toHaveCount(1);

    const overlap = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.msg')].find((m) =>
        m.querySelector('pre[language]'),
      );
      const pre = row?.querySelector('pre[language]');
      const toolbarEl = row?.querySelector('.msg__toolbar');
      if (!row || !pre || !toolbarEl) {
        return null;
      }
      const toolbar = toolbarEl.getBoundingClientRect();
      const block = pre.getBoundingClientRect();
      const after = getComputedStyle(pre, '::after');
      // The caption is generated content, so it has no node to measure — derive its box
      // from the block's edges and the offsets the stylesheet sets.
      const captionBottom = block.bottom - parseFloat(after.bottom || '0');
      const captionTop = captionBottom - parseFloat(after.fontSize || '0');
      const captionLeft = block.left + parseFloat(after.left || '0');
      // Generated content has no node, so its width is measured the way the browser would:
      // the same text in the same font, through a canvas. Estimating it as "the whole block"
      // would guarantee a horizontal overlap with anything right-aligned and make the
      // assertion unfalsifiable in the direction that matters.
      const ctx = document.createElement('canvas').getContext('2d');
      if (!ctx) {
        // Fail loudly. Defaulting the width to 0 here would shrink the caption to a point
        // and quietly weaken the intersection test below, which is the failure mode this
        // whole measurement exists to avoid.
        throw new Error('no 2d context to measure the caption with');
      }
      ctx.font = after.font || `${after.fontSize} ${after.fontFamily}`;
      const captionWidth = ctx.measureText(
        pre.getAttribute('language') ?? '',
      ).width;
      const captionRight = captionLeft + captionWidth;
      return {
        isContinuation: row.classList.contains('msg--cont'),
        // Do the two boxes overlap at all? Asserting non-intersection rather than a vertical
        // gap holds however they are separated — the caption moved to the block's left when
        // the toolbar was raised over the row boundary, and a vertical-gap assertion would
        // have called that a regression when it is the fix.
        overlaps:
          captionLeft < toolbar.right &&
          captionRight > toolbar.left &&
          captionTop < toolbar.bottom &&
          captionBottom > toolbar.top,
      };
    });

    expect(overlap?.isContinuation).toBe(true);
    expect(overlap?.overlaps).toBe(false);
  });
});

// Sender colours (spec A1): computed colours in both themes, and the 3:1 guard dropping a
// colour or background that stops being readable when the theme changes. Values chosen from
// the shipped themes: #e03030 reads on every shipped pane (narrowest: Classic dark, 3.22:1);
// #202020 text and a #ffeb3b background read only in the light theme.
test.describe('Sender colours', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('keeps readable sender colours and drops what loses contrast in the dark theme', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'colours');
    await sendMessage(request, hs, room, {
      body: 'red, near-black and highlighted',
      html: '<span data-mx-color="#e03030">red text</span> <span data-mx-color="#202020">near-black text</span> <span data-mx-bg-color="#ffeb3b">highlighted</span>',
    });
    await signInAndOpen(page, room);
    await page.evaluate(() =>
      document.documentElement.classList.remove('dark'),
    );

    const red = page.locator('.scroll .mx-fg-e03030').first();
    const nearBlack = page.locator('.scroll .mx-fg-202020').first();
    const highlight = page.locator('.scroll .mx-bg-ffeb3b').first();
    await expect(red).toHaveCSS('color', 'rgb(224, 48, 48)', {
      timeout: 20_000,
    });
    await expect(nearBlack).toHaveCSS('color', 'rgb(32, 32, 32)');
    await expect(highlight).toHaveCSS('background-color', 'rgb(255, 235, 59)', {
      timeout: 15_000,
    });

    await page.evaluate(() => document.documentElement.classList.add('dark'));

    await expect(red).toHaveCSS('color', 'rgb(224, 48, 48)', {
      timeout: 15_000,
    });
    await expect(nearBlack).not.toHaveCSS('color', 'rgb(32, 32, 32)', {
      timeout: 15_000,
    });
    await expect(highlight).not.toHaveCSS(
      'background-color',
      'rgb(255, 235, 59)',
      {
        timeout: 15_000,
      },
    );
  });
});

// Inline images (spec A2): an uploaded mxc image renders from authenticated media at most
// 300px tall and opens in the viewer; a remote image in the same message is never fetched.
// A second image claims height="20000": too large to reserve a box, so only the stylesheet's
// 300px cap keeps it from towering over the timeline.
test.describe('Inline images', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('shows an uploaded image at most 300px tall, opens it, and never fetches a remote one', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'inline-image');
    const tall = await uploadPng(request, hs, room, 400, 900, 'tall.png');
    const toweringMxc = await uploadPng(
      request,
      hs,
      room,
      300,
      1200,
      'towering.png',
    );
    const requested: string[] = [];
    page.on('request', (outgoing) => requested.push(outgoing.url()));
    await sendMessage(request, hs, room, {
      body: 'a tall image, a towering image and a remote pixel',
      html: `<p>tall:</p><img src="${tall}" width="400" height="900" alt="A tall test image"><img src="${toweringMxc}" width="400" height="20000" alt="A towering test image"><img src="https://tracker.invalid/pixel.png" alt="remote pixel">`,
    });
    await signInAndOpen(page, room);

    const loaded = (element: HTMLElement | SVGElement): boolean =>
      (element as HTMLImageElement).complete &&
      (element as HTMLImageElement).naturalHeight > 0;

    const image = page.getByRole('button', {
      name: 'View image: A tall test image',
    });
    await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 30_000 });
    await expect
      .poll(() => image.evaluate(loaded), { timeout: 15_000 })
      .toBe(true);
    const box = await image.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(100);
    expect(box?.height ?? Infinity).toBeLessThanOrEqual(300.5);

    const towering = page.getByRole('button', {
      name: 'View image: A towering test image',
    });
    await expect(towering).toHaveAttribute('src', /^blob:/, {
      timeout: 30_000,
    });
    await expect
      .poll(() => towering.evaluate(loaded), { timeout: 15_000 })
      .toBe(true);
    // The stylesheet holds the only cap; nothing inline repeats or overrides it.
    const cap = await towering.evaluate((element) => ({
      computed: parseFloat(getComputedStyle(element).maxHeight),
      inline: (element as HTMLImageElement).style.maxHeight,
    }));
    expect(cap.computed).toBeLessThanOrEqual(300);
    expect(cap.inline).toBe('');
    const toweringBox = await towering.boundingBox();
    expect(toweringBox?.height ?? 0).toBeGreaterThan(100);
    expect(toweringBox?.height ?? Infinity).toBeLessThanOrEqual(300.5);

    await expect(
      page.locator('.scroll .msg__text--html', { hasText: 'remote pixel' }),
    ).toBeVisible({ timeout: 15_000 });
    expect(requested.some((url) => url.includes('tracker.invalid'))).toBe(
      false,
    );

    await image.click();
    const viewer = page.getByRole('dialog', { name: 'A tall test image' });
    await expect(viewer).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden({ timeout: 15_000 });
    // Focus returns to the image that opened the viewer.
    await expect(image).toBeFocused({ timeout: 15_000 });

    // Closing the viewer releases the full image, so Enter downloads it again.
    await page.keyboard.press('Enter');
    await expect(viewer).toBeVisible({ timeout: 20_000 });
    expect(requested.some((url) => url.includes('tracker.invalid'))).toBe(
      false,
    );
  });

  // High Contrast drops the loading box's fill; the stylesheet's outline stays. The thumbnail
  // is held back so the box stays in its loading state for the measurement.
  test('outlines a loading image in forced colours', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'inline-image-forced');
    const mxc = await uploadPng(request, hs, room, 400, 300, 'held.png');
    await sendMessage(request, hs, room, {
      body: 'an image still on its way',
      html: `<img src="${mxc}" width="400" height="300" alt="A held test image">`,
    });
    const held: Route[] = [];
    await page.route(/\/thumbnail\//, (route) => {
      held.push(route);
    });
    await page.emulateMedia({ forcedColors: 'active' });
    await signInAndOpen(page, room);

    const image = page.getByRole('button', {
      name: 'View image: A held test image',
    });
    await expect(image).toHaveClass(/mx-image--loading/, { timeout: 20_000 });
    // It draws the transparent placeholder, decoded, so no broken-image icon shows.
    await expect
      .poll(
        () =>
          image.evaluate((element) => {
            const loading = element as HTMLImageElement;
            return (
              loading.currentSrc.startsWith('data:image/gif') &&
              loading.complete &&
              loading.naturalWidth > 0
            );
          }),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect
      .poll(() => held.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    const box = await image.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        style: style.borderTopStyle,
        width: parseFloat(style.borderTopWidth),
        colour: style.borderTopColor,
        fill: style.backgroundColor,
        height: rect.height,
      };
    });
    expect(box.style).toBe('solid');
    expect(box.width).toBeGreaterThanOrEqual(1);
    expect(box.colour).not.toBe(box.fill);
    expect(box.height).toBeGreaterThan(0);
    await expect(image).toHaveClass(/mx-image--loading/);

    for (const route of held) await route.abort();
  });

  // A concealed spoiler holding an image is a short bar: the image takes no space (which would
  // also give away its size) and is not fetched until the spoiler is revealed.
  test('keeps an image in a concealed spoiler out of the layout until revealed', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'inline-image-spoiler');
    const mxc = await uploadPng(request, hs, room, 300, 200, 'hidden.png');
    const mediaId = mxc.split('/').pop() as string;
    const requested: string[] = [];
    page.on('request', (outgoing) => requested.push(outgoing.url()));
    await sendMessage(request, hs, room, {
      body: 'a spoiler with an image',
      html: `<p>In a spoiler: <span data-mx-spoiler="a picture">look <img src="${mxc}" width="300" height="200" alt="A hidden test image"></span></p>`,
    });
    await signInAndOpen(page, room);

    const spoiler = page.locator('.scroll .mx-spoiler').first();
    await expect(spoiler).toHaveAttribute('label', 'a picture', {
      timeout: 20_000,
    });
    const image = spoiler.locator('img.mx-image');
    await expect(image).toHaveCount(1);
    await expect(image).toBeHidden();
    const lineHeight = () =>
      spoiler.evaluate(
        (element) => element.parentElement?.getBoundingClientRect().height ?? 0,
      );
    expect(await lineHeight()).toBeLessThan(60);
    expect(requested.some((url) => url.includes(mediaId))).toBe(false);

    await spoiler.click();
    await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 30_000 });
    await expect(image).toBeVisible();
    await expect.poll(lineHeight, { timeout: 15_000 }).toBeGreaterThan(150);
  });

  // A spoiler holding only an image, with no reason, would collapse to nothing; it still
  // draws a "Spoiler" bar to click, nested ones one at a time.
  test('draws a bar for a spoiler holding only an image, and reveals it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'inline-image-only');
    const alone = await uploadPng(request, hs, room, 300, 200, 'alone.png');
    const nested = await uploadPng(request, hs, room, 300, 200, 'nested.png');
    await sendMessage(request, hs, room, {
      body: 'spoilers holding only images',
      html: `<p>alone: <span data-mx-spoiler><img src="${alone}" width="300" height="200" alt="An image-only spoiler"></span></p><p>nested: <span data-mx-spoiler><span data-mx-spoiler><img src="${nested}" width="300" height="200" alt="A nested spoiler image"></span></span></p>`,
    });
    await signInAndOpen(page, room);

    const bar = async (spoiler: Locator) => {
      const box = await spoiler.boundingBox();
      return (box?.width ?? 0) > 0 && (box?.height ?? 0) > 0;
    };
    const label = (spoiler: Locator) =>
      spoiler.evaluate(
        (element) => getComputedStyle(element, '::before').content,
      );

    const single = page
      .locator('.scroll p', { hasText: 'alone:' })
      .locator('.mx-spoiler');
    await expect(single).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => bar(single), { timeout: 15_000 }).toBe(true);
    expect(await label(single)).toBe('"Spoiler"');
    await single.click();
    const singleImage = page.getByRole('button', {
      name: 'View image: An image-only spoiler',
    });
    await expect(singleImage).toHaveAttribute('src', /^blob:/, {
      timeout: 30_000,
    });
    await expect(singleImage).toBeVisible();

    const nestedSpoilers = page
      .locator('.scroll p', { hasText: 'nested:' })
      .locator('.mx-spoiler');
    await expect(nestedSpoilers).toHaveCount(2);
    const [outer, inner] = [nestedSpoilers.nth(0), nestedSpoilers.nth(1)];
    await expect.poll(() => bar(outer), { timeout: 15_000 }).toBe(true);
    await outer.click();
    await expect(outer).toHaveClass(/is-revealed/);
    await expect.poll(() => bar(inner), { timeout: 15_000 }).toBe(true);
    expect(await label(inner)).toBe('"Spoiler"');
    await inner.click();
    const nestedImage = page.getByRole('button', {
      name: 'View image: A nested spoiler image',
    });
    await expect(nestedImage).toHaveAttribute('src', /^blob:/, {
      timeout: 30_000,
    });
    await expect(nestedImage).toBeVisible();
  });
});

// Maths (spec B): KaTeX renders inline and display maths with MathML, and neither its chunk
// nor its stylesheet loads until a room shows maths.
const MATHS_CHUNK = /\/maths-render-[A-Za-z0-9]+\.js(?:\?|$)/;
const KATEX_CSS = /\/katex\.css(?:\?|$)/;

test.describe('Maths', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('renders maths with KaTeX, loading it only once a room shows maths', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'maths');
    const mathsRoomName = `maths room ${testResourceId('formulas')}`;
    const mathsRoomId = await addRoom(request, hs, room, mathsRoomName);
    // HTML without maths, so the body goes through the directive that would load KaTeX.
    await sendMessage(request, hs, room, {
      body: 'no formulas here',
      html: '<p><em>no formulas here</em></p>',
    });
    await sendMessage(
      request,
      hs,
      room,
      {
        body: 'Euler and an integral',
        html: '<p>Euler: <span data-mx-maths="e^{i\\pi} + 1 = 0"><code>e^{i\\pi} + 1 = 0</code></span></p><div data-mx-maths="\\int_0^1 x^2 \\, dx"><code>\\int_0^1 x^2 \\, dx</code></div>',
      },
      mathsRoomId,
    );
    const chunks: string[] = [];
    const styles: string[] = [];
    const styleStatuses: number[] = [];
    page.on('request', (outgoing) => {
      if (MATHS_CHUNK.test(outgoing.url())) chunks.push(outgoing.url());
      if (KATEX_CSS.test(outgoing.url())) styles.push(outgoing.url());
    });
    page.on('response', (incoming) => {
      if (KATEX_CSS.test(incoming.url())) styleStatuses.push(incoming.status());
    });

    await signInAndOpen(page, room);
    await expect(
      page.locator('.scroll').getByText('no formulas here', { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    // A negative check needs a window: the directive would ask for KaTeX within a frame of the
    // body rendering, so let two frames pass and then hold for a second.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.waitForTimeout(1_000);
    expect(chunks).toEqual([]);
    expect(styles).toEqual([]);

    await openRoom(page, mathsRoomName);
    await expect(page.locator('.scroll span.mx-maths .katex')).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.locator('.scroll div.mx-maths .katex-display'),
    ).toBeVisible();
    await expect(
      page.locator('.scroll .katex-mathml math').first(),
    ).toBeAttached();
    await expect(page.locator('.scroll .katex-html').first()).toHaveAttribute(
      'aria-hidden',
      'true',
    );
    // The stylesheet MathsLoader links is the `katex` bundle the build emits: it loads and
    // its rules apply.
    await expect.poll(() => styleStatuses, { timeout: 15_000 }).toEqual([200]);
    await expect(page.locator('.scroll span.mx-maths .katex')).toHaveCSS(
      'font-family',
      /KaTeX_Main/,
    );
    // KaTeX's `body { position: relative }` is undone in the same layer.
    expect(
      await page.evaluate(() => getComputedStyle(document.body).position),
    ).toBe('static');

    // Back and forth: still one chunk and one stylesheet.
    await openRoom(page, room.roomName);
    await openRoom(page, mathsRoomName);
    await expect(page.locator('.scroll span.mx-maths .katex')).toBeVisible({
      timeout: 30_000,
    });
    expect(chunks).toHaveLength(1);
    expect(styles).toHaveLength(1);
  });

  // Owner decision 13: maths keeps the body text colour, whether the sender colours the maths
  // itself or text around it. LaTeX KaTeX rejects (an unknown command, a link with trust off)
  // shows as source instead of KaTeX's error rendering.
  test('keeps maths in the text colour and shows the LaTeX KaTeX rejects', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'maths-colour');
    await sendMessage(request, hs, room, {
      body: 'coloured maths and two rejected formulas',
      html:
        '<p>own: <span data-mx-color="#e03030" data-mx-maths="a+b"><code>a+b</code></span></p>' +
        '<p><font color="#e03030">around: <span data-mx-maths="c+d"><code>c+d</code></span></font></p>' +
        '<p>unknown: <span data-mx-maths="\\notacommand{x}"><code>\\notacommand{x}</code></span></p>' +
        '<p>link: <span data-mx-maths="\\href{https://maths.invalid}{y}"><code>\\href{https://maths.invalid}{y}</code></span></p>',
    });
    await signInAndOpen(page, room);

    const body = page.locator('.scroll .msg__text--html', {
      hasText: 'around',
    });
    await expect(body.locator('.mx-maths .katex')).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect(body.locator('.mx-maths code.mx-maths-source')).toHaveText([
      '\\notacommand{x}',
      '\\href{https://maths.invalid}{y}',
    ]);
    await expect(body.locator('.katex-error')).toHaveCount(0);

    const colours = await body.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--trinity-text)';
      element.append(probe);
      const text = getComputedStyle(probe).color;
      probe.remove();
      const maths = [
        ...element.querySelectorAll('.mx-maths .katex, .mx-maths .katex *'),
      ].map((node) => getComputedStyle(node).color);
      const font = element.querySelector('font');
      return {
        text,
        maths: [...new Set(maths)],
        font: font ? getComputedStyle(font).color : null,
      };
    });
    // The colour around the maths is painted, so the reset is what keeps the maths plain.
    expect(colours.font).toBe('rgb(224, 48, 48)');
    expect(colours.maths).toEqual([colours.text]);
  });

  // T17-1: sender TeX cannot draw outside its formula. Lengths past 10em show the source
  // (unit tests); within that bound, kerns and lowered boxes add up, and the stylesheet clips
  // each inline KaTeX run to its own box. Legitimate overhangs keep their pixels.
  test('keeps maths inside its formula without changing legitimate formulas', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'maths-clip');
    const legit = [
      '\\!x',
      '\\kern-0.5em x',
      '\\mathllap{x}',
      '\\raisebox{0.5em}{x}',
      '\\frac{a}{b}',
    ]
      .map((tex) => `<span data-mx-maths="${tex}"><code>${tex}</code></span>`)
      .join(' ');
    await sendMessage(request, hs, room, {
      body: 'formulas that reach outside',
      html:
        '<p>escape: <span data-mx-maths="b\\smash{\\raisebox{-8em}{\\text{fake low}}}"><code>low</code></span>' +
        ' and <span data-mx-maths="c\\smash{\\raisebox{3em}{\\raisebox{3em}{\\text{fake high}}}}"><code>high</code></span>' +
        ' and <span data-mx-maths="d\\smash{\\raisebox{-9em}{\\raisebox{-9em}{\\text{fake deep}}}}"><code>deep</code></span></p>',
    });
    // Sent second, so text the formulas above move down lands on it.
    await sendMessage(request, hs, room, {
      body: 'legitimate formulas',
      html:
        `<p>legit: ${legit}</p>` +
        '<div data-mx-maths="\\sum_{i=1}^{n} i"><code>sum</code></div>' +
        '<div data-mx-maths="\\begin{pmatrix}1&amp;2\\\\3&amp;4\\end{pmatrix}"><code>matrix</code></div>',
    });
    // Last, so it stays on screen: kerns that add up move "Bob" into the sender column.
    await sendMessage(request, hs, room, {
      body: 'a formula that reaches sideways',
      html: '<p><span data-mx-maths="\\kern{-1.5em}\\kern{-1.5em}\\text{Bob}"><code>Bob</code></span> sideways</p>',
    });
    await signInAndOpen(page, room);

    const legitBody = page.locator('.scroll .msg__text--html', {
      hasText: 'legit:',
    });
    const escapeBody = page.locator('.scroll .msg__text--html', {
      hasText: 'escape:',
    });
    const sidewaysBody = page.locator('.scroll .msg__text--html', {
      hasText: 'sideways',
    });
    await expect(legitBody.locator('.mx-maths .katex')).toHaveCount(7, {
      timeout: 30_000,
    });
    await expect(escapeBody.locator('.mx-maths .katex')).toHaveCount(3);
    await expect(sidewaysBody.locator('.mx-maths .katex')).toHaveCount(1);
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    // Nothing these formulas draw reaches outside their message body, give or take the 1em
    // clip margin: around that, the timeline looks the same whether the maths shows or not.
    // Smashed, raised and lowered boxes move text above and below; "Bob" moves sideways.
    const staysInside = async (body: typeof escapeBody): Promise<boolean[]> => {
      const around = await body.evaluate((element) => {
        const pane = element.closest('.scroll')!.getBoundingClientRect();
        const em = parseFloat(
          getComputedStyle(element.querySelector('.katex')!).fontSize,
        );
        const box = element.getBoundingClientRect();
        const [left, top] = [box.left - em, box.top - em];
        const [right, bottom] = [box.right + em, box.bottom + em];
        return [
          {
            x: pane.left,
            y: pane.top,
            width: pane.width,
            height: top - pane.top,
          },
          {
            x: pane.left,
            y: bottom,
            width: pane.width,
            height: pane.bottom - bottom,
          },
          {
            x: pane.left,
            y: Math.max(top, pane.top),
            width: left - pane.left,
            height: Math.min(bottom, pane.bottom) - Math.max(top, pane.top),
          },
          {
            x: right,
            y: Math.max(top, pane.top),
            width: pane.right - right,
            height: Math.min(bottom, pane.bottom) - Math.max(top, pane.top),
          },
        ].filter((region) => region.width >= 1 && region.height >= 1);
      });
      const timeline = () =>
        Promise.all(
          around.map((clip) =>
            page.screenshot({ clip, animations: 'disabled' }),
          ),
        );
      const withMaths = await timeline();
      await body.evaluate((element) =>
        element
          .querySelectorAll<HTMLElement>('.mx-maths')
          .forEach((maths) => (maths.style.visibility = 'hidden')),
      );
      const withoutMaths = await timeline();
      await body.evaluate((element) =>
        element
          .querySelectorAll<HTMLElement>('.mx-maths')
          .forEach((maths) => (maths.style.visibility = '')),
      );
      return withMaths.map((shot, index) => shot.equals(withoutMaths[index]));
    };
    const sideways = await staysInside(sidewaysBody);
    expect(sideways.length).toBeGreaterThanOrEqual(3);
    expect(sideways).toEqual(sideways.map(() => true));
    const vertical = await staysInside(escapeBody);
    expect(vertical).toEqual(vertical.map(() => true));

    // The clip keeps every pixel of the legitimate formulas: lifting it changes nothing.
    const clipped = await legitBody.screenshot({ animations: 'disabled' });
    await page.addStyleTag({
      content:
        '.mx-maths .katex-html > .katex-base { clip-path: none !important; }',
    });
    const unclipped = await legitBody.screenshot({ animations: 'disabled' });
    expect(clipped.equals(unclipped)).toBe(true);
  });

  // KaTeX pins a display formula's \tag to the box's visible right edge; in a formula that
  // scrolls sideways it must come after the formula instead of over it.
  test('keeps the tag of a scrolling display formula after the formula', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'maths-tag');
    const terms = Array.from(
      { length: 40 },
      (_, n) => `\\frac{1}{${n + 1}}`,
    ).join(' + ');
    await sendMessage(request, hs, room, {
      body: 'a long tagged formula',
      html: `<p>tagged:</p><div data-mx-maths="${terms} \\tag{1}"><code>long</code></div>`,
    });
    await signInAndOpen(page, room);

    const display = page.locator('.scroll div.mx-maths');
    await expect(display.locator('.katex-tag')).toHaveText('(1)', {
      timeout: 30_000,
    });
    const layout = await display.evaluate((box) => {
      const bases = [...box.querySelectorAll('.katex-html > .katex-base')];
      const tag = box.querySelector('.katex-tag')!.getBoundingClientRect();
      return {
        scrolls: box.scrollWidth > box.clientWidth,
        formulaEnd: Math.max(
          ...bases.map((base) => base.getBoundingClientRect().right),
        ),
        tagStart: tag.left,
        tagEnd: tag.right,
        scrollEnd: box.getBoundingClientRect().left + box.scrollWidth,
      };
    });
    expect(layout.scrolls).toBe(true);
    expect(layout.tagStart).toBeGreaterThanOrEqual(layout.formulaEnd);
    expect(layout.tagEnd).toBeLessThanOrEqual(layout.scrollEnd + 0.5);
  });

  // High Contrast would paint `\phantom`'s transparent content in the system text colour.
  test('keeps phantom maths invisible in forced colours', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'maths-forced');
    await sendMessage(request, hs, room, {
      body: 'a phantom term',
      html: '<p>phantom: <span data-mx-maths="a\\phantom{b}c"><code>a\\phantom{b}c</code></span></p>',
    });
    await page.emulateMedia({ forcedColors: 'active' });
    await signInAndOpen(page, room);

    const maths = page.locator('.scroll .msg__text--html .mx-maths');
    await expect(maths.locator('.katex')).toBeVisible({ timeout: 30_000 });
    const phantom = maths.locator(".katex-html [style*='transparent']");
    await expect(phantom).toHaveCount(1);
    await expect(phantom).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  });
});
