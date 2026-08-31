import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../fixtures.mts';
import { login, synapseSession, type SynapseSession } from '../support/app.mts';
import { registerUser } from '../support/account.mts';

// End-to-end for "seen by" read receipts: when another member reads a message, their
// avatar appears on it in the reader's timeline. Needs Synapse (Docker).
const session = synapseSession();

async function apiToken(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<{ userId: string; headers: { Authorization: string } }> {
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

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Read receipts (seen by)', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test("shows a reader's avatar on the message they read", async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}s`;
    const hs = session.hs as string;

    await registerUser(request, `rcpt-reader-${runId}`, 'pass-reader');
    await registerUser(request, `rcpt-author-${runId}`, 'pass-author');
    await registerUser(request, `rcpt-seer-${runId}`, 'pass-seer');
    const reader = await apiToken(
      request,
      hs,
      `rcpt-reader-${runId}`,
      'pass-reader',
    );
    const author = await apiToken(
      request,
      hs,
      `rcpt-author-${runId}`,
      'pass-author',
    );
    const seer = await apiToken(request, hs, `rcpt-seer-${runId}`, 'pass-seer');

    const seerName = `Cara${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(seer.userId)}/displayname`,
      { headers: seer.headers, data: { displayname: seerName } },
    );

    const roomName = `Receipts E2E ${runId}`;
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: reader.headers,
        data: { name: roomName, invite: [author.userId, seer.userId] },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);
    for (const who of [author, seer]) {
      await request.post(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        { headers: who.headers },
      );
    }

    // The author sends a message, and the "seer" reads up to it.
    const body = `read receipt target ${runId}`;
    const eventId = await request
      .put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/rcpt-${runId}`,
        { headers: author.headers, data: { msgtype: 'm.text', body } },
      )
      .then((r) => r.json())
      .then((j) => j.event_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      { headers: seer.headers, data: {} },
    );

    await login(page, {
      available: true,
      hs,
      user: `rcpt-reader-${runId}`,
      pass: 'pass-reader',
    } as SynapseSession);
    await openRoom(page, roomName);

    // The seer's read receipt renders as a "seen by" avatar group on the message.
    const receipts = page.locator('.scroll [data-testid="read-receipts"]');
    await expect(receipts.first()).toBeVisible({ timeout: 20_000 });
    await expect(receipts.first()).toHaveAttribute(
      'aria-label',
      new RegExp(seerName),
    );

    // The cluster is out of flow, so a reader part-way through a sender's run does not add
    // height in the middle of it and break the group's rhythm. Measured rather than read off
    // the stylesheet: `position: absolute` is only half the claim — the other half is that
    // the row it sits in is no taller than one without receipts, which is what a reader
    // actually notices and what the windowed list measures.
    // The cluster must not be painted over the message it belongs to.
    //
    // This replaced an assertion that the cluster was OUT of flow. That was the wrong thing
    // to pin: taking it out of flow did remove the height it adds mid-group, and in doing so
    // put the avatars on top of the row's own last line, because the row has 2px of bottom
    // padding and the cluster is ~16px tall. The property that matters to a reader is not
    // where the box sits in the flow — it is that the words stay visible.
    //
    // Measured as box intersection in a real browser: jsdom does no layout, so a unit test
    // cannot tell the two arrangements apart at all.
    const overlap = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid=read-receipts]');
      const row = bar?.closest('.msg');
      const text = row?.querySelector('.msg__text');
      if (!bar || !row || !text) {
        return null;
      }
      const b = bar.getBoundingClientRect();
      const t = text.getBoundingClientRect();
      return {
        intersects:
          b.left < t.right &&
          b.right > t.left &&
          b.top < t.bottom &&
          b.bottom > t.top,
      };
    });

    if (!overlap) {
      throw new Error('expected a row carrying read receipts');
    }
    expect(overlap.intersects).toBe(false);
  });
});
