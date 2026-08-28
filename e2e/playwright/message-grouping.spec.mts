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
    const bodies = ['First message', 'Second message', 'Third message'];

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

    // The hover toolbar belongs to its own row. It used to be parked at `top: -16px`, i.e.
    // deliberately over the row ABOVE — which on a touch device, where the bar is always
    // open, meant every row permanently covered the top of its predecessor. Measured as a
    // box containment rather than read off the stylesheet, because that is the actual claim.
    // A CONTINUATION row specifically, not the first row that happens to carry a bar. A group
    // start is ~60px — taller than the 34px bar — so the residual measured on one is 0 no
    // matter how tall the bar grows, and the bound below would pass by construction. The
    // 26px continuation is the row the reasoning is about and the only one that can fail.
    const containment = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.msg--cont')].find(
        (candidate) => candidate.querySelector('.msg__toolbar'),
      );
      const bar = row?.querySelector('.msg__toolbar');
      if (!row || !bar) {
        return null;
      }
      row.classList.add('msg--revealed');
      const r = row.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const buttons = [...bar.querySelectorAll<HTMLElement>('button')];
      return {
        rowTop: r.top,
        barTop: b.top,
        rowHeight: r.height,
        barHeight: b.height,
        overflowAbove: r.top - b.top,
        overflowBelow: b.bottom - r.bottom,
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
    // Zero or negative: the bar starts at or below its row's top edge, never above it. That
    // is the defect this replaced — a bar at `top: -16px` painted over the row before it.
    expect(containment.overflowAbove).toBeLessThanOrEqual(0);

    // The measured row reserves the toolbar's whole block size. Nothing may overflow into
    // the following positioned row, and every button centre must hit its owning button.
    expect(containment.overflowBelow).toBeLessThanOrEqual(1);
    expect(containment.allButtonsHit).toBe(true);

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

    const compact = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('.msg')].filter(
        (row) => row.querySelector('.msg__text'),
      );
      const start = rows.find((row) => !row.classList.contains('msg--cont'));
      const cont = rows.find((row) => row.classList.contains('msg--cont'));
      const bar = cont?.querySelector<HTMLElement>('.msg__toolbar');
      if (!start || !cont || !bar) return null;
      const rowBox = cont.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      return {
        rowsHeight: rows.reduce(
          (total, row) => total + row.getBoundingClientRect().height,
          0,
        ),
        startPaddingTop: parseFloat(getComputedStyle(start).paddingTop),
        startMarginTop: parseFloat(getComputedStyle(start).marginTop),
        continuationPaddingTop: parseFloat(getComputedStyle(cont).paddingTop),
        overflowAbove: rowBox.top - barBox.top,
        overflowBelow: barBox.bottom - rowBox.bottom,
      };
    });
    if (!compact) throw new Error('expected compact grouped message geometry');
    expect(compact.rowsHeight).toBeLessThan(cosyRowsHeight);
    expect(compact.startPaddingTop).toBe(12);
    expect(compact.startMarginTop).toBe(0);
    expect(compact.continuationPaddingTop).toBe(0);
    expect(compact.overflowAbove).toBeLessThanOrEqual(0);
    expect(compact.overflowBelow).toBeLessThanOrEqual(1);
  });
});
