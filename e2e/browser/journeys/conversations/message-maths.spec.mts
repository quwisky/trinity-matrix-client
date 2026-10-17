import { testResourceId, test, expect } from '../../../fixtures.mts';
import { homeserverSession } from '../../../support/app.mts';
import {
  addRoom,
  openRoom,
  seedFormattedRoom,
  sendMessage,
  signInAndOpen,
  uploadPng,
} from '../../support/formatted-message-journey.mts';
import { sendWithRetry } from '../../support/cs-api.mts';
import { nextTestResourceId } from '../../../support/namespace.mts';

// Covers the markdown render path end to end, through the REAL composer so the wire
// format is exercised, not just the rendering:
//   - a soft line break survives alongside formatting (issue #29's sharpest bug)
//   - a plain multi-line message still goes as plain text, not formatted_body
//   - task lists arrive as ☑/☐ rather than being silently dropped
// Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = homeserverSession();

// Maths (spec B): KaTeX renders inline and display maths with MathML, and neither its chunk
// nor its stylesheet loads until a room shows maths.
const MATHS_CHUNK = /\/maths-render-[A-Za-z0-9]+\.js(?:\?|$)/;
const KATEX_CSS = /\/katex\.css(?:\?|$)/;

test.describe('Maths', () => {
  test.skip(!session.available, 'needs a homeserver');

  // A concealed spoiler hides an emoji and a formula; neither is fetched until it is revealed
  // (#1335): the emoji's request would tell the media server it was shown, and KaTeX is a
  // download a reader who never reveals it does not need.
  test('fetches no emoji or KaTeX for a concealed spoiler until it is revealed', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'spoiler-emoji-maths');
    const mxc = await uploadPng(request, hs, room, 32, 32, 'secret-emoji.png');
    const mediaId = mxc.split('/').pop() as string;
    await sendMessage(request, hs, room, {
      body: 'a spoiler with an emoji and maths',
      html: `<p>hidden: <span data-mx-spoiler><img data-mx-emoticon src="${mxc}" height="32" alt=":secret:"> <span data-mx-maths="x^2"><code>x^2</code></span></span></p>`,
    });
    const media: string[] = [];
    const katex: string[] = [];
    page.on('request', (outgoing) => {
      const url = outgoing.url();
      if (url.includes(mediaId)) media.push(url);
      if (MATHS_CHUNK.test(url) || KATEX_CSS.test(url)) katex.push(url);
    });

    await signInAndOpen(page, room);
    const spoiler = page.locator('.scroll .mx-spoiler').first();
    await expect(spoiler).toBeVisible({ timeout: 20_000 });
    // A negative check needs a window: let two frames pass, then hold for a second.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.waitForTimeout(1_000);
    expect(media).toEqual([]);
    expect(katex).toEqual([]);

    await spoiler.click();

    await expect(spoiler.locator('img.mx-emoticon')).toHaveAttribute(
      'src',
      /^blob:/,
      { timeout: 30_000 },
    );
    await expect(spoiler.locator('.mx-maths .katex')).toBeVisible({
      timeout: 30_000,
    });
    expect(media.length).toBeGreaterThan(0);
  });

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

  // Kerns that add up make one KaTeX run far wider than the body. The body clips it, so a
  // sender cannot cover, or take the clicks of, the shield that marks their message.
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`keeps maths off the message's shield at ${viewport.width}px`, async ({
      page,
      request,
    }) => {
      const hs = session.hs as string;
      const room = await seedFormattedRoom(request, hs, 'maths-shield');
      // Sent without encryption into an encrypted room, so the message is marked.
      await sendWithRetry('enable encryption', () =>
        request.put(
          `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/state/m.room.encryption/`,
          {
            headers: { Authorization: `Bearer ${room.account.accessToken}` },
            data: { algorithm: 'm.megolm.v1.aes-sha2' },
          },
        ),
      );
      await sendMessage(request, hs, room, {
        body: 'wide maths',
        html:
          '<p>wide: <span data-mx-maths="x\\kern{10em}\\kern{8.6em}\\rule{1.5em}{1.5em}"><code>rule</code></span></p>' +
          '<p>far: <span data-mx-maths="y\\hspace{9em}\\hspace{9em}\\hspace{9em}\\hspace{9em}\\rule{1.5em}{1.5em}\\text{over the edge}"><code>far</code></span></p>' +
          // Rules of 10em each, which add up to a bar past the body on any screen.
          '<p>bar: <span data-mx-maths="z\\rule{10em}{0.5em}\\rule{10em}{0.5em}\\rule{10em}{0.5em}\\rule{10em}{0.5em}"><code>bar</code></span></p>',
      });
      await page.setViewportSize(viewport);
      await signInAndOpen(page, room);

      const body = page.locator('.scroll .msg__text--html', {
        hasText: 'wide:',
      });
      await expect(body.locator('.mx-maths .katex')).toHaveCount(3, {
        timeout: 30_000,
      });
      const shield = page.locator('.scroll [data-testid^="msg-shield-"]');
      await expect(shield).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      // The shield's centre is still the shield's to hit.
      const hitsShield = await shield.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return !!hit && element.contains(hit);
      });
      expect(hitsShield).toBe(true);

      // Right of the body, nothing changes when the maths is hidden.
      const beside = await body.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const pane = element.closest('.scroll')!.getBoundingClientRect();
        // Past the focus-ring reach (2px + 2px), on whole pixels.
        const x = Math.ceil(box.right + 4) + 1;
        return {
          x,
          y: Math.floor(box.top),
          width: Math.floor(pane.right) - x,
          height: Math.ceil(box.height),
        };
      });
      expect(beside.width).toBeGreaterThan(16);
      const withMaths = await page.screenshot({
        clip: beside,
        animations: 'disabled',
      });
      await body.evaluate((element) =>
        element
          .querySelectorAll<HTMLElement>('.mx-maths')
          .forEach((maths) => (maths.style.visibility = 'hidden')),
      );
      const withoutMaths = await page.screenshot({
        clip: beside,
        animations: 'disabled',
      });
      expect(withMaths.equals(withoutMaths)).toBe(true);
      await body.evaluate((element) =>
        element
          .querySelectorAll<HTMLElement>('.mx-maths')
          .forEach((maths) => (maths.style.visibility = '')),
      );

      // And its tooltip still opens.
      await shield.hover();
      await expect(page.getByTestId('msg-shield-tip')).toContainText(
        'This message was sent without end-to-end encryption.',
      );
    });
  }

  // A smashed raise on a body's first or last line reaches above or below it. The body clips
  // on every side, so the head line (name, time, "(edited)") and the reactions stay the
  // sender's own to draw and the reader's to click, on a first and a grouped message.
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`keeps maths off the head line and reactions at ${viewport.width}px`, async ({
      page,
      request,
    }) => {
      const hs = session.hs as string;
      const room = await seedFormattedRoom(request, hs, 'maths-head');
      const auth = { Authorization: `Bearer ${room.account.accessToken}` };
      const roomUrl = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}`;
      const reaching = (label: string): string =>
        `<p><span data-mx-maths="\\smash[t]{\\raisebox{1.2em}{\\rule{14em}{1.2em}}}"><code>up</code></span> ${label} first line</p>` +
        `<p>${label} middle <span data-mx-maths="\\smash{\\raisebox{-30em}{\\rule{14em}{1.2em}}}\\smash{\\raisebox{10em}{\\raisebox{10em}{\\raisebox{10em}{\\raisebox{10em}{\\rule{14em}{1.2em}}}}}}"><code>far</code></span></p>` +
        `<p>${label} last line <span data-mx-maths="\\smash[b]{\\raisebox{-2em}{\\rule{14em}{1.2em}}}"><code>down</code></span></p>`;
      const edit = (eventId: string, label: string) =>
        sendWithRetry('edit message', () =>
          request.put(
            `${roomUrl}/send/m.room.message/${nextTestResourceId('txn')}`,
            {
              headers: auth,
              data: {
                msgtype: 'm.text',
                body: `* ${label}`,
                format: 'org.matrix.custom.html',
                formatted_body: reaching(label),
                'm.new_content': {
                  msgtype: 'm.text',
                  body: label,
                  format: 'org.matrix.custom.html',
                  formatted_body: reaching(label),
                },
                'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
              },
            },
          ),
        );
      const react = (eventId: string) =>
        sendWithRetry('react', () =>
          request.put(
            `${roomUrl}/send/m.reaction/${nextTestResourceId('txn')}`,
            {
              headers: auth,
              data: {
                'm.relates_to': {
                  rel_type: 'm.annotation',
                  event_id: eventId,
                  key: '👍',
                },
              },
            },
          ),
        );
      for (const label of ['heading', 'grouped']) {
        const eventId = await sendMessage(request, hs, room, {
          body: label,
          html: reaching(label),
        });
        await edit(eventId, label);
        await react(eventId);
      }
      await page.setViewportSize(viewport);
      await signInAndOpen(page, room);

      const pane = page.locator('.scroll');
      for (const label of ['heading', 'grouped']) {
        const body = pane.locator('.msg__text--html', {
          hasText: `${label} first line`,
        });
        await expect(body.locator('.mx-maths .katex')).toHaveCount(3, {
          timeout: 30_000,
        });
        const row = pane.locator('.msg', {
          has: page.locator('.msg__text--html', {
            hasText: `${label} first line`,
          }),
        });
        await expect(row.getByTestId('msg-edited')).toBeVisible({
          timeout: 20_000,
        });
        await expect(row.locator('.reaction').first()).toBeVisible({
          timeout: 20_000,
        });
      }
      await page.evaluate(() => document.fonts.ready.then(() => undefined));

      const heading = pane.locator('.msg', {
        has: page.locator('.msg__text--html', {
          hasText: 'heading first line',
        }),
      });
      const grouped = pane.locator('.msg', {
        has: page.locator('.msg__text--html', {
          hasText: 'grouped first line',
        }),
      });
      await expect(grouped).toHaveClass(/msg--cont/);
      const targets = [
        heading.locator('.msg__author'),
        heading.locator('.msg__time'),
        heading.getByTestId('msg-edited'),
        heading.locator('.reaction').first(),
        grouped.getByTestId('msg-edited'),
        grouped.locator('.reaction').first(),
      ];
      // Each target's centre is its own to hit; a miss names what took it (class names only).
      const hits: string[] = [];
      for (const target of targets) {
        // Far moves can make a body taller than the pane; bring each target into view first.
        await target.scrollIntoViewIfNeeded();
        hits.push(
          await target.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2,
            );
            return hit && element.contains(hit)
              ? 'itself'
              : `${element.localName}.${element.className} → ${hit?.localName}.${hit?.getAttribute('class')}`;
          }),
        );
      }
      expect(hits).toEqual(targets.map(() => 'itself'));

      // Around each body, past the focus-ring reach, nothing changes when its maths is hidden.
      for (const label of ['heading', 'grouped']) {
        const body = pane.locator('.msg__text--html', {
          hasText: `${label} first line`,
        });
        await body.scrollIntoViewIfNeeded();
        const around = await body.evaluate((element) => {
          const scroller = element.closest('.scroll')!.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          const reach = 5;
          const left = Math.floor(box.left) - reach;
          const right = Math.ceil(box.right) + reach;
          const top = Math.max(Math.floor(box.top) - reach, scroller.top);
          const bottom = Math.min(
            Math.ceil(box.bottom) + reach,
            scroller.bottom,
          );
          return [
            {
              x: scroller.left,
              y: scroller.top,
              width: scroller.width,
              height: top - scroller.top,
            },
            {
              x: scroller.left,
              y: bottom,
              width: scroller.width,
              height: scroller.bottom - bottom,
            },
            {
              x: scroller.left,
              y: top,
              width: left - scroller.left,
              height: bottom - top,
            },
            {
              x: right,
              y: top,
              width: scroller.right - right,
              height: bottom - top,
            },
          ]
            .map((region) => ({
              x: Math.ceil(region.x),
              y: Math.ceil(region.y),
              width: Math.floor(region.width),
              height: Math.floor(region.height),
            }))
            .filter((region) => region.width >= 1 && region.height >= 1);
        });
        const shots = () =>
          Promise.all(
            around.map((clip) =>
              page.screenshot({ clip, animations: 'disabled' }),
            ),
          );
        const withMaths = await shots();
        await body.evaluate((element) =>
          element
            .querySelectorAll<HTMLElement>('.mx-maths')
            .forEach((maths) => (maths.style.visibility = 'hidden')),
        );
        const withoutMaths = await shots();
        await body.evaluate((element) =>
          element
            .querySelectorAll<HTMLElement>('.mx-maths')
            .forEach((maths) => (maths.style.visibility = '')),
        );
        expect(
          withMaths.map((shot, index) => shot.equals(withoutMaths[index])),
        ).toEqual(around.map(() => true));
      }
    });
  }

  // The body clip must not cut list numbers: one too long for the indent sits inside its item.
  test('keeps long list numbers whole inside the body clip', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'list-numbers');
    await sendMessage(request, hs, room, {
      body: 'long list numbers',
      html:
        '<p>lists:</p><ol start="100000"><li>far along</li><li>further</li></ol>' +
        '<ol start="95"><li>a</li><li>b</li><li>c</li><li>d</li></ol>' +
        '<ol><li>one</li><li>two</li></ol>',
    });
    await signInAndOpen(page, room);

    const body = page.locator('.scroll .msg__text--html', {
      hasText: 'far along',
    });
    await expect(body).toBeVisible({ timeout: 20_000 });
    // Six digits sit inside their items; two get a wider indent; one keeps the usual.
    const positions = await body.evaluate((element) =>
      [...element.querySelectorAll('ol')].map(
        (list) => getComputedStyle(list).listStylePosition,
      ),
    );
    expect(positions).toEqual(['inside', 'outside', 'outside']);

    // Lifting the clip changes no pixel: no number reached past it.
    const around = await body.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        x: Math.floor(box.left) - 40,
        y: Math.floor(box.top),
        width: Math.ceil(box.width) + 40,
        height: Math.ceil(box.height),
      };
    });
    const clipped = await page.screenshot({
      clip: around,
      animations: 'disabled',
    });
    await page.addStyleTag({
      content: '.msg__text--html { overflow: visible !important; }',
    });
    const unclipped = await page.screenshot({
      clip: around,
      animations: 'disabled',
    });
    expect(clipped.equals(unclipped)).toBe(true);
  });

  // A run KaTeX cannot wrap, wider than the body, scrolls sideways on its own; the timeline,
  // the thread and the page never get a sideways scroll range from it.
  test('scrolls wide inline maths on its own, in the timeline and a thread', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'maths-wide');
    const terms = Array.from({ length: 60 }, (_, n) => `a_{${n}}`).join('+');
    const wide = (label: string): string =>
      `<p>${label}: <span data-mx-maths="\\left(${terms}\\right)\\text{END}"><code>wide</code></span> after</p>`;
    const rootId = await sendMessage(request, hs, room, {
      body: 'wide root',
      html:
        wide('root') +
        '<p><a href="https://example.org/">edge link</a> and <span data-mx-maths="x^2+\\frac{a}{b}"><code>narrow</code></span></p>',
    });
    await sendWithRetry('thread reply', () =>
      request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room.roomId)}/send/m.room.message/${nextTestResourceId('txn')}`,
        {
          headers: { Authorization: `Bearer ${room.account.accessToken}` },
          data: {
            msgtype: 'm.text',
            body: 'wide reply',
            format: 'org.matrix.custom.html',
            formatted_body: wide('reply'),
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
    await signInAndOpen(page, room);

    const rootBody = page.locator('.scroll .msg__text--html', {
      hasText: 'root:',
    });
    await expect(rootBody.locator('.mx-maths .katex')).toHaveCount(2, {
      timeout: 30_000,
    });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    /** The formula scrolls, and scrolling it to its end brings "END" into view. */
    const scrollsToEnd = (body: typeof rootBody) =>
      body.locator('span.mx-maths--wide').evaluate(async (maths) => {
        const scrolls = maths.scrollWidth > maths.clientWidth + 1;
        maths.scrollLeft = maths.scrollWidth;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const end = [...maths.querySelectorAll('.text')].at(-1)!;
        const box = maths.getBoundingClientRect();
        const last = end.getBoundingClientRect();
        return {
          scrolls,
          endShown: last.right <= box.right + 1 && last.left >= box.left - 1,
        };
      });
    const noSidewaysRange = (selector: string) =>
      page.locator(selector).evaluate((element) => ({
        pane: element.scrollWidth - element.clientWidth,
        page:
          document.scrollingElement!.scrollWidth -
          document.scrollingElement!.clientWidth,
      }));

    await expect(rootBody.locator('span.mx-maths--wide')).toHaveCount(1);
    expect(await scrollsToEnd(rootBody)).toEqual({
      scrolls: true,
      endShown: true,
    });
    expect(await noSidewaysRange('.scroll')).toEqual({ pane: 0, page: 0 });

    // The pad-and-pull-back moves nothing: lifting it (and the clip) changes no pixel of the
    // narrow formula's paragraph.
    const narrow = rootBody.locator('p', { hasText: 'edge link' });
    const before = await narrow.screenshot({ animations: 'disabled' });

    // A ring on a link at the body's edge is whole: the clip changes none of its pixels.
    const link = narrow.getByRole('link', { name: 'edge link' });
    await page.keyboard.press('Shift');
    await link.focus();
    const ringArea = await link.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.floor(rect.left) - 8,
        y: Math.floor(rect.top) - 8,
        width: Math.ceil(rect.width) + 16,
        height: Math.ceil(rect.height) + 16,
      };
    });
    const ringed = await page.screenshot({
      clip: ringArea,
      animations: 'disabled',
    });
    const lifted = await page.addStyleTag({
      content: '.msg__text--html { overflow: visible !important; }',
    });
    expect(
      (
        await page.screenshot({ clip: ringArea, animations: 'disabled' })
      ).equals(ringed),
    ).toBe(true);
    await link.blur();
    await page.addStyleTag({
      content:
        '.msg__text--html { padding-inline: 0 !important; padding-bottom: 0 !important; margin-inline: 0 !important; margin-bottom: 0 !important; max-width: var(--trinity-measure-prose) !important; }',
    });
    expect(
      (await narrow.screenshot({ animations: 'disabled' })).equals(before),
    ).toBe(true);
    await lifted.evaluate((style) => (style as HTMLStyleElement).remove());

    // The same in the thread.
    await page
      .locator('.scroll .msg', {
        has: page.locator('.msg__text--html', { hasText: 'root:' }),
      })
      .getByTestId('message-thread-summary')
      .click();
    const thread = page.getByTestId('thread-view');
    const replyBody = thread.locator('.msg__text--html', {
      hasText: 'reply:',
    });
    await expect(replyBody.locator('span.mx-maths--wide')).toHaveCount(1, {
      timeout: 30_000,
    });
    expect(await scrollsToEnd(replyBody)).toEqual({
      scrolls: true,
      endShown: true,
    });
    expect(
      await noSidewaysRange('[data-testid="thread-view"] .thread'),
    ).toEqual({ pane: 0, page: 0 });
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
