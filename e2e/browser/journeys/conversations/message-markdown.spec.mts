import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
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
  seedFormattedRoom,
  sendMessage,
  signInAndOpen,
} from '../../support/formatted-message-journey.mts';
import { createRoom } from '../../support/space-journey.mts';

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
    const roomId = await createRoom(
      request,
      hs,
      { accessToken: token },
      roomName,
    );

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
    await createRoom(request, hs, { accessToken: token }, roomName);

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
    await createRoom(request, hs, { accessToken: token }, roomName);

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
