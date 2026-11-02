import { testResourceId, test, expect } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser, apiLogin } from '../../../support/account.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';
import { createRoom } from '../../support/space-journey.mts';

// End-to-end for "seen by" read receipts: when another member reads a message, their
// avatar appears on it in the reader's timeline. Needs Synapse (Docker).
const session = homeserverSession();

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
    const reader = await apiLogin(
      request,
      hs,
      `rcpt-reader-${runId}`,
      'pass-reader',
    );
    const author = await apiLogin(
      request,
      hs,
      `rcpt-author-${runId}`,
      'pass-author',
    );
    const seer = await apiLogin(request, hs, `rcpt-seer-${runId}`, 'pass-seer');

    const seerName = `Cara${runId}`;
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(seer.userId)}/displayname`,
      { headers: seer.headers, data: { displayname: seerName } },
    );

    const roomName = `Receipts E2E ${runId}`;
    const roomId = await createRoom(request, hs, reader, roomName, {
      invite: [author.userId, seer.userId],
    });
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
    } as HomeserverSession);
    await openRoom(page, roomName);

    // The seer's read receipt renders as a "seen by" avatar group on the message.
    const receipts = page.locator('.scroll [data-testid="read-receipts"]');
    await expect(receipts.first()).toBeVisible({ timeout: 20_000 });
    await expect(receipts.first()).toHaveAttribute(
      'aria-label',
      new RegExp(seerName),
    );

    // A receipt must not move the conversation: the strip takes the same room with or without
    // readers, and it lies below the message rather than over it. jsdom does no layout, so this
    // is measured in a real browser.
    const layout = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(
        '[data-testid=read-receipts]',
      );
      const scroller = bar?.closest<HTMLElement>('.scroll');
      const rows = scroller?.querySelectorAll<HTMLElement>('.msg');
      const lastRow = rows?.[rows.length - 1];
      if (!bar || !scroller || !lastRow) {
        return null;
      }
      const inRow = bar.closest('.msg') !== null;
      const clear =
        bar.getBoundingClientRect().top >=
        lastRow.getBoundingClientRect().bottom - 1;
      const withReaders = scroller.scrollHeight;
      bar.style.display = 'none';
      const without = scroller.scrollHeight;
      bar.style.display = '';
      return { inRow, clear, withReaders, without };
    });

    expect(layout).not.toBeNull();
    expect(layout!.inRow).toBe(false);
    expect(layout!.clear).toBe(true);
    expect(layout!.withReaders).toBe(layout!.without);

    // A newer message takes the readers away until they catch up, and catching up moves nothing.
    const newer = `newer message ${runId}`;
    const newerId = await request
      .put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/rcpt-newer-${runId}`,
        { headers: author.headers, data: { msgtype: 'm.text', body: newer } },
      )
      .then((r) => r.json())
      .then((j) => j.event_id as string);
    const newest = page.locator('.scroll .msg', { hasText: newer });
    await expect(newest).toBeVisible({ timeout: 20_000 });
    await expect(receipts).toHaveCount(0, { timeout: 20_000 });
    const before = await newest.boundingBox();

    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(newerId)}`,
      { headers: seer.headers, data: {} },
    );
    await expect(receipts).toHaveCount(1, { timeout: 20_000 });
    expect(await newest.boundingBox()).toEqual(before);

    // Readers acknowledge the newest raw event, here a reaction with no row of its own.
    const reactionId = await request
      .put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/rcpt-react-${runId}`,
        {
          headers: author.headers,
          data: {
            'm.relates_to': {
              rel_type: 'm.annotation',
              event_id: newerId,
              key: '👍',
            },
          },
        },
      )
      .then((r) => r.json())
      .then((j) => j.event_id as string);
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(reactionId)}`,
      { headers: seer.headers, data: {} },
    );
    await expect(newest.locator('trn-message-reactions')).toBeVisible({
      timeout: 20_000,
    });
    await expect(receipts).toHaveAttribute('aria-label', new RegExp(seerName));
  });
});
