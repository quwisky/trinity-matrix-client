import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from './support/fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  waitForSent,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the markdown render path end to end, through the REAL composer so the wire
// format is exercised, not just the rendering:
//   - a soft line break survives alongside formatting (issue #29's sharpest bug)
//   - a plain multi-line message still goes as plain text, not formatted_body
//   - task lists arrive as ☑/☐ rather than being silently dropped
//   - fenced code is syntax-highlighted, and follows the theme
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

/** Type a message with real newlines: Shift+Enter inserts one, Enter sends. */
async function sendLines(page: Page, lines: readonly string[]): Promise<void> {
  const composer = page.getByTestId('composer-input');
  await composer.click();
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      await composer.press('Shift+Enter');
    }
    // pressSequentially, not fill: the composer's mention/emoji autocomplete and draft
    // persistence all hang off per-key input events. (Locator.type is deprecated.)
    await composer.pressSequentially(line);
  }
  await composer.press('Enter');
}

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
    const runId = `${Date.now().toString(36)}md`;
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

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // 1. A plain multi-line message.
    await sendLines(page, ['plain one', 'plain two']);
    await expect(
      page.locator('.msg__text', { hasText: 'plain one' }),
    ).toBeVisible({ timeout: 20_000 });

    // 2. The same shape, but with formatting — this is the bug: before the fix the
    //    line break vanished the moment anything was bold.
    await sendLines(page, ['**bold one**', 'rich two']);
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
    const runId = `${Date.now().toString(36)}tl`;
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

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // Only the first marker is typed. Shift+Enter carries the whole marker onto the next
    // line — bullet AND task box, always unticked — so the second line is just its text.
    // Typing `- ` again would nest a second list; typing `[ ] ` again would put a literal
    // `[ ]` inside the item, which is what this spec caught when the box started carrying.
    await sendLines(page, ['- [x] shipped', 'pending']);

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
    const runId = `${Date.now().toString(36)}ov`;
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

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // A leading message makes the block a CONTINUATION row — no author header to push it
    // down, which is where the row's hover toolbar sits lowest over it. Hovering the block
    // necessarily hovers the message, so the two are always shown together.
    await sendLines(page, ['setting up']);
    await page.waitForTimeout(500);
    await sendLines(page, ['```python', 'x = 1', '```']);

    const pre = page.locator('.msg__text--html pre').first();
    await expect(pre).toBeVisible({ timeout: 20_000 });
    await waitForSent(
      page.locator('.scroll .msg[data-mid]', { hasText: 'x = 1' }).first(),
    );
    if (!isAndroidE2E) await pre.hover();

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
        toolbarOpacity: getComputedStyle(toolbarEl).opacity,
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
    if (isAndroidE2E) {
      // Touch cannot enter the hover state measured on web. The caption is always
      // visible and the toolbar stays concealed until a long press reveals this row,
      // so intersecting dormant boxes do not overlap painted controls.
      expect(overlap?.toolbarOpacity).toBe('0');
    } else {
      expect(overlap?.overlaps).toBe(false);
    }
  });

  test('syntax-highlights a fenced block, in the theme’s colours', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}hl`;
    const user = `code-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Code ${runId}`;

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

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    const source = `def greet(n): return "${'scrollbar-proof-'.repeat(16)}"`;
    await sendLines(page, ['```python', source, '```']);

    // Settle on the remote echo first. The row is re-created when the real event id
    // arrives, and evaluating getComputedStyle across that swap resolves against a
    // detached node, which returns '' — a flake that reads as a highlighting failure.
    await waitForSent(
      page.locator('.scroll .msg[data-mid]', { hasText: 'greet' }).first(),
    );

    const block = page.locator('.msg__text--html pre code').first();
    await expect(block).toBeVisible({ timeout: 20_000 });
    // The language survives the sanitizer, and the highlighter consumed it.
    await expect(block).toHaveClass(/language-python/);
    await expect(block.locator('.tok-keyword').first()).toHaveText('def');
    // Tokenizing must not alter a single character of someone's code.
    await expect(block).toHaveText(source);

    // The colours come from --trinity-syntax-*, so they follow the mode. If they were
    // hardcoded (or emitted as inline `style`, which Angular strips) neither would apply.
    //
    // Both modes are forced and asserted against their expected value rather than merely
    // "the colour changed": the app may already have resolved to dark (ThemeService
    // defaults to `system`), in which case adding the class is a no-op and a
    // changed/not-changed check would spin without saying why.
    const keyword = block.locator('.tok-keyword').first();
    const colourIn = async (mode: 'light' | 'dark') => {
      await page.evaluate((m) => {
        document.documentElement.classList.toggle('dark', m === 'dark');
      }, mode);
      return keyword.evaluate((el) => getComputedStyle(el).color);
    };

    // The two --trinity-syntax-keyword values: #a626a4 light, #c678dd dark.
    expect(await colourIn('light')).toBe('rgb(166, 38, 164)');
    expect(await colourIn('dark')).toBe('rgb(198, 120, 221)');

    // The language is captioned on the block, and only shown while pointing at it. The
    // caption is generated content from a `language` attribute, so it never becomes part of
    // the message's text — assert it the way the browser sees it.
    const pre = page.locator('.msg__text--html pre').first();
    await expect(pre).toHaveAttribute('language', 'python');

    // This is a real horizontal overflow surface, not a synthetic test node. Its bar uses
    // the same geometry and theme-aware thumb as vertical panels throughout the shell.
    const horizontalScrollbar = await pre.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.cssText =
        'position:absolute;height:var(--trinity-scrollbar-size);background:var(--trinity-scrollbar-thumb)';
      element.append(probe);
      const probeStyle = getComputedStyle(probe);
      const bar = getComputedStyle(element, '::-webkit-scrollbar');
      const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb');
      const result = {
        overflow: element.scrollWidth - element.clientWidth,
        height: bar.height,
        thumb: thumb.backgroundColor,
        expectedHeight: probeStyle.height,
        expectedThumb: probeStyle.backgroundColor,
      };
      probe.remove();
      return result;
    });
    expect(horizontalScrollbar.overflow).toBeGreaterThan(0);
    expect(horizontalScrollbar.height).toBe(horizontalScrollbar.expectedHeight);
    expect(horizontalScrollbar.thumb).toBe(horizontalScrollbar.expectedThumb);

    const captionStyle = () =>
      pre.evaluate((el) => {
        const style = getComputedStyle(el, '::after');
        return { content: style.content, opacity: style.opacity };
      });

    expect((await captionStyle()).content).toContain('python');
    expect((await captionStyle()).opacity).toBe(isAndroidE2E ? '1' : '0');
    if (!isAndroidE2E) {
      await pre.hover();
      await expect.poll(async () => (await captionStyle()).opacity).toBe('1');
    }

    // And it stays out of the text: the <pre> reads exactly as its <code> does, so
    // selecting or copying the block yields only the sender's source — and the
    // edit-history diff, which compares rendered text, never sees the caption.
    expect(await pre.evaluate((el) => el.textContent)).toBe(
      await block.evaluate((el) => el.textContent),
    );

    // The block carries the same optical correction inline code does. Both compute to 85%
    // of the prose around them: a monospace face reads larger than the proportional UI font
    // at an equal computed size, so an uncorrected block towers over the conversation even
    // though the numbers match. Asserted as a RATIO against real rendered prose rather than
    // as a px value, so it holds at every Text size rather than pinning one of them.
    const correction = await block.evaluate((el) => {
      const body = el.closest('.msg__text--html');
      if (!body) {
        throw new Error('code block is not inside a rendered message body');
      }
      const size = (node: Element) =>
        parseFloat(getComputedStyle(node).fontSize);
      return size(el) / size(body);
    });

    expect(correction).toBeCloseTo(0.85, 2);

    // An unknown language still renders, just without tokens and without erroring.
    await sendLines(page, ['```nosuchlang', 'anything at all', '```']);
    const unknown = page
      .locator('.msg__text--html pre code', { hasText: 'anything at all' })
      .first();
    await expect(unknown).toBeVisible({ timeout: 20_000 });
    await expect(unknown.locator('.tok-keyword')).toHaveCount(0);
  });
});
