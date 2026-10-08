import { writeFileSync } from 'node:fs';
import {
  testResourceId,
  test,
  expect,
  devices,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Pins the message row's grid placement: the gutter standing in for the avatar, the header
// time, and the receipts with their "seen by" list sit where the stylesheet puts them. The
// row host is `display: contents` and `.msg__body` is a grid, so a child component that
// gained a box of its own would move these without any unit test noticing; jsdom does no
// layout. Set TRN_ROW_LAYOUT_DUMP to a path to also write the raw measurements, which is how
// a refactor of the row is compared before and after.
const session = homeserverSession();

async function apiLogin(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
) {
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

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        gridColumn: cs.gridColumnStart + '/' + cs.gridColumnEnd,
        gridRow: cs.gridRowStart + '/' + cs.gridRowEnd,
        display: cs.display,
      };
    };
    return [...document.querySelectorAll('.msg[data-mid]')]
      .filter((row) => row.querySelector('.msg__text'))
      .map((row) => ({
        text: row.querySelector('.msg__text')?.textContent?.trim(),
        msg: box(row),
        lead: box(row.querySelector('.msg__avatar, .msg__gutter')),
        time: box(row.querySelector('.msg__time')),
        body: box(row.querySelector('.msg__body')),
        receipts: box(row.querySelector('.msg__receipts')),
        seenBy: box(row.querySelector('.msg__seen-by')),
      }));
  });
}

// Dropped from the profile: `use({ defaultBrowserType })` inside a describe forces a new worker.
const { defaultBrowserType: _browser, ...pixel5 } = devices['Pixel 5'];

for (const [name, use] of [
  ['desktop', {}],
  ['Pixel 5', pixel5],
] as const) {
  test.describe(`Message row layout (${name})`, () => {
    test.use(use);
    test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

    test('places time, gutter, receipts and seen-by in the body grid', async ({
      page,
      request,
    }) => {
      const hs = session.hs as string;
      const runId = `${testResourceId('run')}rl`;
      const me = `rl-me-${runId}`;
      const reader = `rl-rd-${runId}`;
      const roomName = `Layout ${runId}`;
      await registerUser(request, me, `${me}-pass`);
      await registerUser(request, reader, `${reader}-pass`);
      const author = await apiLogin(request, hs, me, `${me}-pass`);
      const other = await apiLogin(request, hs, reader, `${reader}-pass`);
      const readerName = `Reader ${runId}`;
      await request.put(
        `${hs}/_matrix/client/v3/profile/${encodeURIComponent(other.userId)}/displayname`,
        { headers: other.headers, data: { displayname: readerName } },
      );
      const { room_id } = await request
        .post(`${hs}/_matrix/client/v3/createRoom`, {
          headers: author.headers,
          data: {
            name: roomName,
            preset: 'private_chat',
            invite: [other.userId],
          },
        })
        .then((r) => r.json());
      await request.post(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
        { headers: other.headers },
      );
      const bodies = ['First', 'Second', 'Third message of the group'];
      let last = '';
      for (const [i, body] of bodies.entries()) {
        const res = await request
          .put(
            `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-${i}`,
            { headers: author.headers, data: { msgtype: 'm.text', body } },
          )
          .then((r) => r.json());
        last = res.event_id as string;
      }
      await request.post(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/receipt/m.read/${encodeURIComponent(last)}`,
        { headers: other.headers, data: {} },
      );

      await login(page, {
        available: true,
        hs,
        user: me,
        pass: `${me}-pass`,
      } as HomeserverSession);
      await page.getByTestId('rail-rooms').click();
      const channel = page.locator('.channel', { hasText: roomName }).first();
      await expect(channel).toBeVisible({ timeout: 30_000 });
      await channel.click();
      await expect(
        page.locator('.msg__text', { hasText: bodies[2] }),
      ).toBeVisible({ timeout: 30_000 });
      const cluster = page.getByTestId('read-receipts').first();
      await expect(cluster).toBeVisible({ timeout: 20_000 });
      await cluster.click();
      await expect(page.getByTestId('seen-by-list').first()).toContainText(
        readerName,
      );

      const rows = await measure(page);
      expect(rows).toHaveLength(bodies.length);
      const [head, mid, tail] = rows;
      // The header row leads with the avatar and carries the time in its head line.
      expect(head.time).not.toBeNull();
      expect(mid.time).toBeNull();
      // Continuations stand a 40px gutter in for the avatar, aligned with the avatar column.
      expect(head.lead?.w).toBe(40);
      expect(mid.lead?.w).toBe(40);
      expect(mid.lead?.x).toBe(head.lead?.x);
      // Receipts and their list sit inside the last row's body, list below the cluster.
      expect(tail.receipts).not.toBeNull();
      expect(tail.seenBy).not.toBeNull();
      expect(tail.seenBy!.y).toBeGreaterThanOrEqual(
        tail.receipts!.y + tail.receipts!.h - 1,
      );
      expect(tail.receipts!.x).toBeGreaterThanOrEqual(tail.body!.x);
      expect(tail.seenBy!.y + tail.seenBy!.h).toBeLessThanOrEqual(
        tail.msg!.y + tail.msg!.h + 1,
      );

      const dump = process.env['TRN_ROW_LAYOUT_DUMP'];
      if (dump) {
        writeFileSync(
          `${dump}.${name.replace(' ', '')}.json`,
          JSON.stringify(rows, null, 1),
        );
      }
    });
  });
}
