import { test, expect, type Locator, type Route } from '../../../fixtures.mts';
import { homeserverSession } from '../../../support/app.mts';
import {
  seedFormattedRoom,
  sendMessage,
  signInAndOpen,
  uploadPng,
} from '../../support/formatted-message-journey.mts';

// Inline images in messages. Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = homeserverSession();

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

  // An inline image declares no file name or type: it saves under its alt text with the
  // extension its bytes declare, and the viewer hides the app behind it (#1338).
  test('saves an inline image under its alt text with the extension its bytes declare', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'inline-image-save');
    const mxc = await uploadPng(request, hs, room, 300, 200, 'upload.png');
    await sendMessage(request, hs, room, {
      body: 'an inline image to save',
      html: `<p>save me: <img src="${mxc}" width="300" height="200" alt="A saved picture"></p>`,
    });
    await signInAndOpen(page, room);

    const image = page.locator('.scroll img.mx-image').first();
    await expect(image).toHaveAttribute('src', /^blob:/, { timeout: 30_000 });
    await image.click();
    const dialog = page.getByRole('dialog', { name: 'A saved picture' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    // The media matte: opaque black, whatever the theme.
    await expect(dialog.locator('trn-lightbox')).toHaveCSS(
      'background-color',
      'oklch(0 0 0)',
    );

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByTestId('lightbox-download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('A saved picture.png');
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
