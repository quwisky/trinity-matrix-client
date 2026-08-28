import { test, expect, type APIRequestContext } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the Discord-style grouping of consecutive messages from one sender: the
// follow-on rows drop the avatar for a hover-only timestamp gutter, which must measure
// exactly as wide as the avatar it replaces (40px) or every grouped message lands out
// of line with the first.
//
// This can only be caught in a real browser — the regression was a *layout* one (a flex
// item's automatic minimum size overriding its declared basis), and jsdom does no
// layout, so a component spec cannot see it. Needs Synapse (Docker).
const session = synapseSession();

/** The avatar size a header row reserves; the grouped gutter must match it. */
const LEAD_WIDTH = 40;

interface ApiUser {
  userId: string;
  headers: { Authorization: string };
}

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<ApiUser> {
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

test.describe('Message grouping', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('grouped messages line up with the first of their group', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}mg`;
    const me = `mg-me-${runId}`;
    const mePass = `${me}-pass`;
    const roomName = `Grouping ${runId}`;
    const bodies = [
      'First message',
      'Second message with enough text to reach the trailing action track without the reserved inset',
      'Third message',
    ];

    await registerUser(request, me, mePass);
    const author = await apiLogin(request, hs, me, mePass);

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: author.headers,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());

    // Same sender, back to back: rows 2 and 3 group under row 1's header.
    for (const [i, body] of bodies.entries()) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-${i}`,
        { headers: author.headers, data: { msgtype: 'm.text', body } },
      );
    }

    await login(page, {
      available: true,
      hs,
      user: me,
      pass: mePass,
    } as SynapseSession);
    // A named, non-DM room is listed under the Rooms view rather than Home's DMs.
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName }).first();
    await expect(channel).toBeVisible({ timeout: 30_000 });
    await channel.click();

    for (const body of bodies) {
      await expect(page.locator('.msg__text', { hasText: body })).toBeVisible({
        timeout: 30_000,
      });
    }

    // Exactly one header row, and the other two grouped under it.
    await expect(page.locator('.msg .msg__avatar')).toHaveCount(1);
    await expect(page.locator('.msg--cont')).toHaveCount(bodies.length - 1);

    // The invariant: the gutter standing in for the avatar is the same width, so the
    // bodies share a left edge. Measured, not asserted from the stylesheet — the bug
    // was the used width silently exceeding the declared one.
    const lead = await page.evaluate(() =>
      [...document.querySelectorAll('.msg')]
        .filter((row) => row.querySelector('.msg__text'))
        .map((row) => {
          const el = row.querySelector('.msg__avatar, .msg__gutter');
          return el ? el.getBoundingClientRect().width : null;
        }),
    );
    expect(lead).toEqual(bodies.map(() => LEAD_WIDTH));

    const textLeft = await page.evaluate(() =>
      [...document.querySelectorAll('.msg__text')].map(
        (el) => el.getBoundingClientRect().left,
      ),
    );
    expect(textLeft).toHaveLength(bodies.length);
    for (const left of textLeft) {
      expect(left).toBeCloseTo(textLeft[0], 1);
    }

    // The group gap, measured rather than read off the stylesheet — and specifically as
    // PADDING inside the border box. `virtual-message-list` sizes every row with
    // `entry.borderBoxSize[0].blockSize`, which margins sit outside of, so a gap applied as
    // `margin-top` would look identical on screen here and silently undercount the windowed
    // scroll by the gap on every group start. Asserting the border box is what tells the two
    // apart; jsdom cannot, because it does no layout at all.
    const gap = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.msg')].filter((row) =>
        row.querySelector('.msg__text'),
      );
      const start = rows.find((row) => !row.classList.contains('msg--cont'));
      const cont = rows.find((row) => row.classList.contains('msg--cont'));
      if (!start || !cont) {
        return null;
      }
      const read = (el: Element) => {
        const cs = getComputedStyle(el);
        return {
          paddingTop: parseFloat(cs.paddingTop),
          marginTop: parseFloat(cs.marginTop),
          // What the ResizeObserver would report for this row.
          borderBox: el.getBoundingClientRect().height,
        };
      };
      return { start: read(start), cont: read(cont) };
    });

    if (!gap) {
      throw new Error('expected both a group start and a continuation row');
    }
    // The start carries the gap; the continuation carries none.
    expect(gap.start.paddingTop).toBeGreaterThanOrEqual(16);
    expect(gap.cont.paddingTop).toBe(0);
    // And it is not margin — which is the half a screenshot could not tell you, and the half
    // that matters: `virtual-message-list` sizes rows from `borderBoxSize[0].blockSize`, and
    // padding is inside the border box while margin is outside it. These two lines together
    // ARE the proof; there is no third measurement to take.
    //
    // (There used to be one — `start.borderBox - cont.borderBox >= 15`, commented "so the
    // measured height really does include it". It could not fail for that reason: a group
    // start already carries an avatar and an author line, so it is ~36px taller than a
    // continuation whatever the gap is. It has been removed rather than left to look like
    // evidence.)
    expect(gap.start.marginTop).toBe(0);

    // The hover toolbar floats over the trailing row boundary instead of reserving a permanent
    // action gutter. Measure a CONTINUATION row specifically: it has no author header or group
    // padding to disguise either a lost strip of message width or excessive vertical overlap.
    const containment = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.msg--cont')].find(
        (candidate) => candidate.querySelector('.msg__toolbar'),
      );
      const bar = row?.querySelector('.msg__toolbar');
      const text = row?.querySelector('.msg__text');
      if (!row || !bar || !text) {
        return null;
      }
      row.classList.add('msg--revealed');
      const r = row.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const t = text.getBoundingClientRect();
      const messageRows = [...document.querySelectorAll('.msg')].filter(
        (candidate) => candidate.querySelector('.msg__text'),
      );
      const previousText =
        messageRows[messageRows.indexOf(row) - 1]?.querySelector<HTMLElement>(
          '.msg__text',
        );
      const previousTextBox = previousText?.getBoundingClientRect();
      const body = row.querySelector('.msg__body')?.getBoundingClientRect();
      const rowStyle = getComputedStyle(row);
      const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
      const buttons = [...bar.querySelectorAll<HTMLElement>('button')];
      return {
        rowTop: r.top,
        barTop: b.top,
        rowHeight: r.height,
        barHeight: b.height,
        barWidth: b.width,
        overflowAbove: r.top - b.top,
        overflowBelow: b.bottom - r.bottom,
        bodyEndGap:
          body === undefined
            ? null
            : r.right - parseFloat(rowStyle.paddingInlineEnd) - body.right,
        textOverlap: Math.max(
          0,
          Math.min(b.bottom, t.bottom) - Math.max(b.top, t.top),
        ),
        lineHeight,
        previousTextOverlap:
          previousTextBox === undefined
            ? null
            : Math.max(
                0,
                Math.min(b.bottom, previousTextBox.bottom) -
                  Math.max(b.top, previousTextBox.top),
              ),
        previousLineHeight:
          previousText == null
            ? null
            : parseFloat(getComputedStyle(previousText).lineHeight),
        buttonSizes: buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
        allButtonsHit: buttons.every((button) => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return hit !== null && button.contains(hit);
        }),
      };
    });

    if (!containment) {
      throw new Error('expected a continuation row carrying a toolbar');
    }
    // Full message width: the body reaches the row content edge rather than stopping before
    // a four-button action track. The toolbar is compact and straddles only the upper boundary.
    expect(containment.bodyEndGap).not.toBeNull();
    expect(Math.abs(containment.bodyEndGap ?? Infinity)).toBeLessThanOrEqual(1);
    expect(containment.barWidth).toBeLessThanOrEqual(100);
    expect(containment.overflowAbove).toBeGreaterThan(0);
    expect(containment.overflowAbove).toBeLessThanOrEqual(
      (containment.barHeight * 2) / 3 + 1,
    );
    expect(containment.overflowBelow).toBeLessThanOrEqual(1);
    expect(containment.textOverlap).toBeLessThanOrEqual(
      containment.lineHeight / 2 + 1,
    );
    expect(containment.previousTextOverlap).not.toBeNull();
    expect(containment.previousLineHeight).not.toBeNull();
    expect(containment.previousTextOverlap ?? Infinity).toBeLessThanOrEqual(
      (containment.previousLineHeight ?? 0) - 1,
    );
    expect(
      containment.buttonSizes.every(
        ({ width, height }) => width >= 24 && height >= 24,
      ),
    ).toBe(true);
    expect(containment.allButtonsHit).toBe(true);

    // A continuation can become the first visible row after normal or virtual scrolling.
    // Clamp against the real scrollport rather than assuming only group starts reach its edge.
    // Add one tall message so the real scrollport has enough content below the continuation to
    // align it at the top; shrinking the viewport with inline styles races the timeline's own
    // ResizeObserver and does not represent a user scroll.
    await page
      .locator('.msg--cont.msg--revealed')
      .evaluateAll((rows) =>
        rows.forEach((row) => row.classList.remove('msg--revealed')),
      );
    const edgeFiller = Array.from(
      { length: 32 },
      (_, index) => `edge filler ${runId} ${index + 1}`,
    ).join('\n');
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-edge`,
      {
        headers: author.headers,
        data: { msgtype: 'm.text', body: edgeFiller },
      },
    );
    const filler = page.locator('.msg__text', {
      hasText: `edge filler ${runId} 32`,
    });
    await expect(filler).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => filler.evaluate((node) => node.clientHeight))
      .toBeGreaterThan(600);

    const firstActionRow = page
      .locator('.msg--cont')
      .filter({ hasText: `edge filler ${runId} 32` });
    await expect(firstActionRow).toBeVisible({ timeout: 20_000 });
    await firstActionRow.evaluate(async (row) => {
      const scroller = row.closest('.scroll');
      if (!scroller) return;
      row.scrollIntoView({ block: 'start', inline: 'nearest' });
      scroller.dispatchEvent(new Event('scroll'));
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await expect
      .poll(() =>
        firstActionRow.evaluate((row) => {
          const scroller = row.closest('.scroll');
          if (!scroller) return Infinity;
          return Math.abs(
            row.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top,
          );
        }),
      )
      .toBeLessThanOrEqual(1);
    await firstActionRow.evaluate((row) => row.classList.add('msg--revealed'));
    await firstActionRow
      .locator('.msg__toolbar')
      .dispatchEvent('pointerenter', { pointerType: 'mouse' });
    await expect(firstActionRow.locator('.msg__toolbar')).toHaveCSS(
      'opacity',
      '1',
    );
    // The row is deliberately flush with the scrollport edge. Playwright's
    // actionability scroll would centre the absolutely positioned button and invalidate that
    // geometry before the application measures it, so activate the already-proven hit target
    // in place.
    await firstActionRow
      .getByRole('button', { name: 'Add reaction' })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(firstActionRow.locator('.toolbar__picker')).toBeVisible();
    await expect
      .poll(() =>
        firstActionRow
          .locator('.msg__toolbar')
          .evaluate((bar) =>
            bar.classList.contains('toolbar-host--picker-below'),
          ),
      )
      .toBe(true);
    const topEdge = await firstActionRow.evaluate((row) => {
      const scroller = row.closest('.scroll');
      const bar = row.querySelector<HTMLElement>('.msg__toolbar');
      const picker = row.querySelector<HTMLElement>('.toolbar__picker');
      if (!scroller || !bar || !picker) return null;
      const measure = () => {
        const scrollBox = scroller.getBoundingClientRect();
        const boxes = [bar, picker].map((element) =>
          element.getBoundingClientRect(),
        );
        const controls = [
          ...bar.querySelectorAll<HTMLElement>('.toolbar > button'),
          ...picker.querySelectorAll<HTMLElement>('button'),
        ];
        return {
          contained: boxes.every(
            (box) =>
              box.top >= scrollBox.top - 1 &&
              box.right <= scrollBox.right + 1 &&
              box.bottom <= scrollBox.bottom + 1 &&
              box.left >= scrollBox.left - 1,
          ),
          blockedControls: controls.flatMap((control) => {
            const box = control.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            if (hit !== null && control.contains(hit)) return [];
            return [
              {
                label:
                  control.getAttribute('aria-label') ??
                  control.getAttribute('title') ??
                  control.textContent?.trim() ??
                  '',
                blocker:
                  hit instanceof HTMLElement
                    ? `${hit.tagName.toLowerCase()}.${hit.className}`
                    : null,
              },
            ];
          }),
        };
      };
      const ltr = measure();
      document.documentElement.dir = 'rtl';
      const rtl = measure();
      document.documentElement.removeAttribute('dir');
      return { ltr, rtl };
    });
    expect(topEdge).not.toBeNull();
    expect(topEdge?.ltr.contained).toBe(true);
    expect(topEdge?.ltr.blockedControls).toEqual([]);
    expect(topEdge?.rtl.contained).toBe(true);
    expect(topEdge?.rtl.blockedControls).toEqual([]);
    await firstActionRow
      .getByRole('button', { name: 'Add reaction' })
      .evaluate((button: HTMLButtonElement) => button.click());
    await page.locator('[data-testid="composer-input"]').hover();
    const restingActionRow = page
      .locator('.msg--cont')
      .filter({ hasText: bodies[2] });
    await restingActionRow.evaluate((row) => {
      row.scrollIntoView({ block: 'center', inline: 'nearest' });
      row.closest('.scroll')?.dispatchEvent(new Event('scroll'));
    });
    await expect(restingActionRow).toBeVisible({ timeout: 20_000 });

    // Compact is a rendered timeline mode, not merely an attribute or a token declaration.
    // Tighten the live document and prove the measured conversation consumes less vertical
    // space while the two virtualization/toolbar contracts above remain true.
    const cosyRowsHeight = await page
      .locator('.msg')
      .evaluateAll((rows) =>
        rows
          .filter((row) => row.querySelector('.msg__text'))
          .reduce(
            (total, row) => total + row.getBoundingClientRect().height,
            0,
          ),
      );
    await page.locator('html').evaluate((html) => {
      html.setAttribute('data-density', 'compact');
    });
    await expect(page.locator('.msg').first()).toHaveCSS('column-gap', '8px');
    await restingActionRow
      .locator('.msg__toolbar')
      .dispatchEvent('pointerenter', { pointerType: 'mouse' });

    const compact = await page.evaluate((restingBody) => {
      const rows = [...document.querySelectorAll<HTMLElement>('.msg')].filter(
        (row) => row.querySelector('.msg__text'),
      );
      const start = rows.find((row) => !row.classList.contains('msg--cont'));
      const cont = rows.find(
        (row) =>
          row.classList.contains('msg--cont') &&
          row.textContent?.includes(restingBody),
      );
      const bar = cont?.querySelector<HTMLElement>('.msg__toolbar');
      if (!start || !cont || !bar) return null;
      cont.classList.add('msg--revealed');
      const rowBox = cont.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      const text = cont.querySelector<HTMLElement>('.msg__text');
      const textBox = text?.getBoundingClientRect();
      const bodyBox = cont
        .querySelector<HTMLElement>('.msg__body')
        ?.getBoundingClientRect();
      const rowStyle = getComputedStyle(cont);
      const buttons = [...bar.querySelectorAll<HTMLElement>('button')];
      return {
        rowsHeight: rows.reduce(
          (total, row) => total + row.getBoundingClientRect().height,
          0,
        ),
        startPaddingTop: parseFloat(getComputedStyle(start).paddingTop),
        startMarginTop: parseFloat(getComputedStyle(start).marginTop),
        continuationPaddingTop: parseFloat(getComputedStyle(cont).paddingTop),
        bodyEndGap:
          bodyBox === undefined
            ? null
            : rowBox.right -
              parseFloat(rowStyle.paddingInlineEnd) -
              bodyBox.right,
        barWidth: barBox.width,
        barHeight: barBox.height,
        textOverlap:
          textBox === undefined
            ? null
            : Math.max(
                0,
                Math.min(barBox.bottom, textBox.bottom) -
                  Math.max(barBox.top, textBox.top),
              ),
        lineHeight:
          text === null ? null : parseFloat(getComputedStyle(text).lineHeight),
        buttonSizes: buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
        allButtonsHit: buttons.every((button) => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          );
          return hit !== null && button.contains(hit);
        }),
        overflowAbove: rowBox.top - barBox.top,
        overflowBelow: barBox.bottom - rowBox.bottom,
      };
    }, bodies[2]);
    if (!compact) throw new Error('expected compact grouped message geometry');
    expect(compact.rowsHeight).toBeLessThan(cosyRowsHeight);
    expect(compact.startPaddingTop).toBe(12);
    expect(compact.startMarginTop).toBe(0);
    expect(compact.continuationPaddingTop).toBe(0);
    expect(compact.bodyEndGap).not.toBeNull();
    expect(Math.abs(compact.bodyEndGap ?? Infinity)).toBeLessThanOrEqual(1);
    expect(compact.barWidth).toBeLessThanOrEqual(100);
    expect(compact.overflowAbove).toBeGreaterThan(0);
    expect(compact.overflowAbove).toBeLessThanOrEqual(
      (compact.barHeight * 2) / 3 + 1,
    );
    expect(compact.overflowBelow).toBeLessThanOrEqual(1);
    expect(compact.textOverlap).not.toBeNull();
    expect(compact.lineHeight).not.toBeNull();
    expect(compact.textOverlap ?? Infinity).toBeLessThanOrEqual(
      (compact.lineHeight ?? 0) / 2 + 1,
    );
    expect(
      compact.buttonSizes.every(
        ({ width, height }) => width >= 24 && height >= 24,
      ),
    ).toBe(true);
    expect(compact.allButtonsHit).toBe(true);

    // A desktop user agent with touch emulation keeps the desktop toolbar interaction model
    // while exercising the coarse-pointer capability used by hybrid laptops.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    await expect
      .poll(() =>
        page.evaluate(() => matchMedia('(any-pointer: coarse)').matches),
      )
      .toBe(true);
    await restingActionRow.evaluate((row) =>
      row.classList.add('msg--revealed'),
    );
    await restingActionRow.locator('.msg__toolbar').evaluate((bar) => {
      bar.dispatchEvent(
        new PointerEvent('pointerenter', { pointerType: 'mouse' }),
      );
    });
    await restingActionRow
      .getByRole('button', { name: 'Add reaction' })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(restingActionRow.locator('.toolbar__picker')).toBeVisible();
    const hybridControls = await restingActionRow.evaluate((row) => {
      const controls = [
        ...row.querySelectorAll<HTMLElement>('.toolbar > button'),
        ...row.querySelectorAll<HTMLElement>('.toolbar__picker button'),
      ];
      return controls.map((control) => {
        const box = control.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return {
          width: box.width,
          height: box.height,
          hit: hit !== null && control.contains(hit),
        };
      });
    });
    expect(
      hybridControls.every(
        ({ width, height, hit }) => width >= 44 && height >= 44 && hit,
      ),
    ).toBe(true);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  });
});
