import { expect, test, testResourceId } from '../../fixtures.mts';
import { registerUser } from '../../support/account.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  waitForSent,
  type SynapseSession,
} from '../../support/app.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../support/message-composer.mts';

const session = synapseSession();

test.describe('Code block rendering', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('syntax-highlights a fenced block, in the theme’s colours', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}hl`;
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
      .then((response) => response.json())
      .then((body) => body.access_token as string);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openNamedRoom(page, roomName);

    const source = `def greet(n): return "${'scrollbar-proof-'.repeat(16)}"`;
    await sendComposerLines(page, ['```python', source, '```']);

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
    // "the colour changed": the app may already have resolved system Mode to dark, in
    // which case adding the class is a no-op and a
    // changed/not-changed check would spin without saying why.
    const keyword = block.locator('.tok-keyword').first();
    const colourIn = async (mode: 'light' | 'dark') => {
      await page.evaluate((value) => {
        document.documentElement.classList.toggle('dark', value === 'dark');
      }, mode);
      return keyword.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--trinity-syntax-keyword)';
        element.append(probe);
        const colours = {
          actual: getComputedStyle(element).color,
          expected: getComputedStyle(probe).color,
        };
        probe.remove();
        return colours;
      });
    };

    const lightColours = await colourIn('light');
    const darkColours = await colourIn('dark');
    expect(lightColours.actual).toBe(lightColours.expected);
    expect(darkColours.actual).toBe(darkColours.expected);
    expect(lightColours.expected).not.toBe(darkColours.expected);

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
      const railProbe = document.createElement('span');
      railProbe.style.cssText =
        'position:absolute;background:var(--trinity-rail)';
      element.append(probe);
      element.append(railProbe);
      const probeStyle = getComputedStyle(probe);
      const railProbeStyle = getComputedStyle(railProbe);
      const usesWebkit =
        !navigator.userAgent.includes('Firefox') &&
        CSS.supports('selector(::-webkit-scrollbar-thumb)');
      const bar = usesWebkit
        ? getComputedStyle(element, '::-webkit-scrollbar')
        : undefined;
      const thumb = usesWebkit
        ? getComputedStyle(element, '::-webkit-scrollbar-thumb')
        : undefined;
      const originalScrollLeft = element.scrollLeft;
      element.scrollLeft = element.scrollWidth;
      const result = {
        usesWebkit,
        overflow: element.scrollWidth - element.clientWidth,
        scrollLeft: element.scrollLeft,
        standardColor: getComputedStyle(element).scrollbarColor,
        height: bar?.height,
        thumb: thumb?.backgroundColor,
        expectedHeight: probeStyle.height,
        expectedThumb: probeStyle.backgroundColor,
        expectedRail: railProbeStyle.backgroundColor,
      };
      element.scrollLeft = originalScrollLeft;
      probe.remove();
      railProbe.remove();
      return result;
    });
    expect(horizontalScrollbar.overflow).toBeGreaterThan(0);
    expect(horizontalScrollbar.scrollLeft).toBeGreaterThan(0);
    expect(horizontalScrollbar.expectedRail).not.toBe('rgba(0, 0, 0, 0)');
    expect(horizontalScrollbar.expectedThumb).toBe(
      horizontalScrollbar.expectedRail,
    );
    if (horizontalScrollbar.usesWebkit) {
      expect(horizontalScrollbar.height).toBe(
        horizontalScrollbar.expectedHeight,
      );
      expect(horizontalScrollbar.thumb).toBe(horizontalScrollbar.expectedThumb);
    } else {
      expect(horizontalScrollbar.standardColor).toContain(
        horizontalScrollbar.expectedRail,
      );
    }

    const captionStyle = () =>
      pre.evaluate((element) => {
        const style = getComputedStyle(element, '::after');
        return { content: style.content, opacity: style.opacity };
      });

    const caption = await captionStyle();
    // Firefox serializes generated attr() content as the function rather than its value.
    expect(
      caption.content === 'attr(language)' ||
        caption.content.includes('python'),
    ).toBe(true);
    expect((await captionStyle()).opacity).toBe(isAndroidE2E ? '1' : '0');
    if (!isAndroidE2E) {
      await pre.hover();
      await expect.poll(async () => (await captionStyle()).opacity).toBe('1');
    }

    // And it stays out of the text: the <pre> reads exactly as its <code> does, so
    // selecting or copying the block yields only the sender's source — and the
    // edit-history diff, which compares rendered text, never sees the caption.
    expect(await pre.evaluate((element) => element.textContent)).toBe(
      await block.evaluate((element) => element.textContent),
    );

    // The block carries the same optical correction inline code does. Both compute to 85%
    // of the prose around them: a monospace face reads larger than the proportional UI font
    // at an equal computed size, so an uncorrected block towers over the conversation even
    // though the numbers match. Asserted as a ratio against real rendered prose rather than
    // as a px value, so it holds at every Text size rather than pinning one of them.
    const correction = await block.evaluate((element) => {
      const body = element.closest('.msg__text--html');
      if (!body) {
        throw new Error('code block is not inside a rendered message body');
      }
      const size = (node: Element) =>
        Number.parseFloat(getComputedStyle(node).fontSize);
      return size(element) / size(body);
    });

    expect(correction).toBeCloseTo(0.85, 2);

    // An unknown language still renders, just without tokens and without erroring.
    await sendComposerLines(page, ['```nosuchlang', 'anything at all', '```']);
    const unknown = page
      .locator('.msg__text--html pre code', { hasText: 'anything at all' })
      .first();
    await expect(unknown).toBeVisible({ timeout: 20_000 });
    await expect(unknown.locator('.tok-keyword')).toHaveCount(0);
  });
});
