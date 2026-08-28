import { test, expect, type Page } from './support/fixtures.mts';
import {
  clickRowToolbar,
  login,
  synapseSession,
  waitForSent,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the thread composer (data-testid="thread-view"): the room-scoped actions
// (poll/location/voice) are hidden there because they post to the main room,
// not the thread; and a slash command typed in a thread is parsed (`/me waves` sends an
// emote "waves", not the literal text). Needs a Synapse homeserver (Docker); self-skips.
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

test.describe('Thread composer', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('hides room-scoped actions and parses slash commands in a thread', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}thr`;
    const user = `thr-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Thread ${runId}`;
    const rootBody = `thread root ${runId}`;

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

    // Send a message, then open a thread off it via the hover toolbar.
    const composer = page.getByTestId('composer-input');
    await composer.fill(rootBody);
    await composer.press('Enter');
    const row = page.locator('.scroll .msg[data-mid]', { hasText: rootBody });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });
    // A thread hangs off its root's event id, so the root has to be sent for real
    // first — "Reply in thread" is withheld from an unsent local echo (whose id is
    // only a `~txnId` placeholder the homeserver could never resolve).
    await waitForSent(row.first());
    await clickRowToolbar(
      row.first(),
      row.first().getByRole('button', { name: 'Reply in thread' }),
    );

    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible({ timeout: 15_000 });

    // The room-only actions (poll/location/voice) post to the main room, so the thread
    // composer never offers them: with only attach left and no GIF provider it collapses
    // to a plain attach button rather than a tray. So the thread has no `+` menu trigger,
    // just `composer-insert-attach`. (The room composer's tray contents — including that
    // it omits these when richActions is off — are covered as a unit in
    // message-composer.component.spec.ts, where the CDK menu can be opened.)
    await expect(thread.getByTestId('composer-insert')).toHaveCount(0);
    await expect(thread.getByTestId('composer-insert-attach')).toBeVisible();

    // A slash command is parsed in the thread: `/me waves` sends an emote "waves".
    const threadInput = thread.getByTestId('composer-input');
    await threadInput.fill('/me waves');
    await threadInput.press('Enter');

    await expect(
      thread.locator('.msg', { hasText: 'waves' }).first(),
    ).toBeVisible({ timeout: 20_000 });
    // The command was interpreted, not sent as literal text.
    await expect(thread).not.toContainText('/me waves');

    // The shared Phase 3 treatment reaches the thread surface too: its composer is the same
    // integrated bordered field and its read-only/message rows consume the message body role.
    await expect(thread.getByTestId('composer-field')).toHaveCSS(
      'border-top-style',
      'solid',
    );
    await expect(thread.locator('.msg__text', { hasText: 'waves' })).toHaveCSS(
      'font-size',
      '13px',
    );
  });

  // The thread panel is the one place the indicator sits in a NON-flex parent
  // (`.thread__footer` is a plain block), so it is where a layout assumption carried over
  // from the two lists would break. Measured in a real engine because jsdom applies no
  // CSS and cannot see a collapsed slot at all.
  test('reserves the typing row space in the thread panel too', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}tht`;
    const user = `tht-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Thread ${runId}`;
    const rootBody = `root ${runId}`;

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

    const composer = page.getByTestId('composer-input');
    await composer.fill(rootBody);
    await composer.press('Enter');
    const row = page.locator('.scroll .msg[data-mid]', { hasText: rootBody });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });
    await waitForSent(row.first());
    await clickRowToolbar(
      row.first(),
      row.first().getByRole('button', { name: 'Reply in thread' }),
    );

    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible({ timeout: 15_000 });

    // The HOST, not `.typing-slot`, and against a real threshold rather than `> 0`. The slot
    // is a block child that generates its own box whatever the host does, and with the
    // reservation gone it still measures its own 6px of padding — so `> 0` on either element
    // passes on a broken tree, which is what the first version of this test did.
    //
    // A reserved row is one 1.2rem line plus 6px ≈ 25px. Losing `min-height` collapses it to
    // that 6px, so 20px separates the two with room for font-metric drift.
    const idle = await thread
      .locator('trn-typing-indicator')
      .evaluate((element) => element.getBoundingClientRect().height);

    expect(idle).toBeGreaterThan(20);

    // And it does not announce: the list behind it carries the same room-scoped names.
    await expect(thread.getByTestId('typing-status')).toHaveCount(0);
  });
});
