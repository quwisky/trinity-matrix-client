import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  waitForSent,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';

// Covers the web hover toolbar over rendered markdown, through the REAL composer: a code
// block's generated language caption stays clear of the row's hover toolbar. The wire
// format, line-break, task-list and Android code-caption journeys run through
// android.message-markdown (#748).
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

test.describe('Message markdown', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps the language caption clear of the hover toolbar', async ({
    page,
    request,
  }) => {
    test.skip(
      isAndroidE2E,
      'Android runs this through android.message-markdown (#748).',
    );
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

    await login(page, { available: true, hs, user, pass } as SynapseSession);
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
