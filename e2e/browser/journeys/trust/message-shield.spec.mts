import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  waitForRooms,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';

// Covers per-message authenticity shields (message-row `data-testid="msg-shield-*"`):
// that a plaintext room raises none, that a genuinely shielded message explains itself,
// and that a message sent without encryption into an encrypted room is marked as such.
// The homeserver accepts those raw events, so they are sent through the client-server API.
//
// A shield can only be provoked for real: it takes an encrypted room, a cross-signing
// identity to judge against, and a second device that identity has never signed. That
// is what the second test builds, because nothing cheaper produces the state — the
// unit tests can assert the mapping and the tooltip, but only a live pair of devices
// proves the SDK actually raises a shield here at all.
// Needs a Synapse homeserver (Docker); self-skips.
const session = homeserverSession();

/**
 * Bootstrap cross-signing + recovery on the first device. Without an own identity the
 * SDK has nothing to judge a second device against and reports no shield at all — so
 * this is a precondition of the shielded case, not decoration.
 */
async function setUpEncryption(page: Page, password: string): Promise<void> {
  await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set up encryption' }).click();

  // The UIA password prompt is conditional on the Synapse build / account state, so
  // race it against the recovery key and only answer it if it actually appears.
  const uia = page.locator('trn-alert-dialog');
  const key = page.locator('code.key');
  const shown = await Promise.race([
    uia
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'uia')
      .catch(() => null),
    key
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'key')
      .catch(() => null),
  ]);
  if (shown === 'uia') {
    await uia.locator('input[type="password"]').fill(password);
    await uia.getByRole('button', { name: 'Confirm' }).click();
  }

  await key.waitFor({ state: 'visible', timeout: 60_000 });
  await page
    .getByRole('checkbox', { name: /I've saved my recovery key/ })
    .click();
  await page.getByRole('button', { name: 'Continue to Trinity' }).click();
  await waitForRooms(page);
}

/** Open a joined, named (non-DM) room from the Rooms view and wait for its composer. */
async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName }).first();
  await channel.waitFor({ state: 'visible', timeout: 60_000 });
  await channel.click();
  await page
    .locator('textarea.composer__input')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
}

/** The message row showing `text`. */
const rowOf = (page: Page, text: string) =>
  page
    .locator('.msg', { has: page.locator('.msg__text', { hasText: text }) })
    .first();

/**
 * Two accounts sharing a named room that starts unencrypted: the owner sends through the
 * client-server API, the reader is who the test logs into the client as.
 */
async function setUpSharedRoom(
  request: APIRequestContext,
  hs: string,
  tag: string,
) {
  const runId = `${testResourceId('run')}${tag}`;
  const owner = `shield-${tag}-owner-${runId}`;
  const reader = `shield-${tag}-reader-${runId}`;
  const roomName = `Shared ${runId}`;
  await registerUser(request, owner, `${owner}-pass`);
  await registerUser(request, reader, `${reader}-pass`);
  const ownerToken = (await passwordLogin(request, hs, owner, `${owner}-pass`))
    .accessToken;
  const readerLogin = await passwordLogin(
    request,
    hs,
    reader,
    `${reader}-pass`,
  );
  const ownerAuth = { Authorization: `Bearer ${ownerToken}` };
  const readerAuth = { Authorization: `Bearer ${readerLogin.accessToken}` };

  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: ownerAuth,
      data: {
        name: roomName,
        preset: 'private_chat',
        invite: [readerLogin.userId],
      },
    })
    .then((r) => r.json());
  const roomUrl = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}`;
  await request.post(`${roomUrl}/join`, { headers: readerAuth });

  return {
    runId,
    roomName,
    roomUrl,
    ownerAuth,
    readerAuth,
    ownerSession: {
      available: true,
      hs,
      user: owner,
      pass: `${owner}-pass`,
    } as HomeserverSession,
    readerSession: {
      available: true,
      hs,
      user: reader,
      pass: `${reader}-pass`,
    } as HomeserverSession,
    /** A plain-text message from the owner, sent through the API. */
    async sendText(txn: string, body: string): Promise<void> {
      const sent = await request.put(
        `${roomUrl}/send/m.room.message/${runId}-${txn}`,
        { headers: ownerAuth, data: { msgtype: 'm.text', body } },
      );
      expect(sent.ok()).toBe(true);
    },
    async enableEncryption(): Promise<void> {
      const enabled = await request.put(`${roomUrl}/state/m.room.encryption/`, {
        headers: ownerAuth,
        data: { algorithm: 'm.megolm.v1.aes-sha2' },
      });
      expect(enabled.ok()).toBe(true);
    },
  };
}

test.describe('Message authenticity shields', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a message in a plaintext room shows no shield', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sh`;
    const owner = `shield-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const reader = `shield-reader-${runId}`;
    const readerPass = `${reader}-pass`;
    const roomName = `Plain ${runId}`;
    const body = `plaintext message ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, reader, readerPass);
    const ownerSession = await passwordLogin(request, hs, owner, ownerPass);
    const readerSession = await passwordLogin(request, hs, reader, readerPass);
    const ownerAuth = {
      Authorization: `Bearer ${ownerSession.accessToken}`,
    };
    const readerAuth = {
      Authorization: `Bearer ${readerSession.accessToken}`,
    };

    // A plaintext room (no encryption initial_state) — its messages get no shield.
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: ownerAuth,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [readerSession.userId],
        },
      })
      .then((r) => r.json());
    // The reader must actually join, else the room lands as an invite (not a joined
    // `.channel`) in their rail and the timeline never opens.
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: readerAuth },
    );
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-msg`,
      { headers: ownerAuth, data: { msgtype: 'm.text', body } },
    );

    await login(page, {
      available: true,
      hs,
      user: reader,
      pass: readerPass,
    } as HomeserverSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    // The message renders in the timeline (scope to the message text, not the
    // sidebar preview which shows the same body), and carries no authenticity
    // shield (plaintext room).
    await expect(page.locator('.msg__text', { hasText: body })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('[data-testid^="msg-shield-"]')).toHaveCount(0);
  });

  test('a shielded message explains itself in a tooltip', async ({
    page,
    secondaryApp,
    request,
  }) => {
    // Two UI logins plus a cross-signing bootstrap; well past the default budget.
    test.slow();

    const hs = session.hs as string;
    const runId = `${testResourceId('run')}st`;
    const user = `shield-tip-${runId}`;
    const pass = `${user}-pass`;
    const seerUser = `shield-seer-${runId}`;
    const seerPass = `${seerUser}-pass`;
    const seerName = `Shield reader ${runId}`;
    const roomName = `Sealed ${runId}`;
    // Long enough to wrap to the row's right edge: the shield must reserve its own
    // column rather than let the text run underneath it.
    const body = `encrypted from an unsigned device ${runId} — long enough that this line wraps all the way across the message body and reaches the right-hand edge of the row`;

    await registerUser(request, user, pass);
    await registerUser(request, seerUser, seerPass);
    const ownerSession = await passwordLogin(request, hs, user, pass);
    const seerSession = await passwordLogin(request, hs, seerUser, seerPass);
    const seerAuth = {
      Authorization: `Bearer ${seerSession.accessToken}`,
    };
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(seerSession.userId)}/displayname`,
      { headers: seerAuth, data: { displayname: seerName } },
    );

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${ownerSession.accessToken}` },
        data: {
          name: roomName,
          preset: 'private_chat',
          initial_state: [
            {
              type: 'm.room.encryption',
              state_key: '',
              content: { algorithm: 'm.megolm.v1.aes-sha2' },
            },
          ],
        },
      })
      .then((r) => r.json());
    expect(room_id).toBeTruthy();
    const ownerAuth = {
      Authorization: `Bearer ${ownerSession.accessToken}`,
    };
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/invite`,
      { headers: ownerAuth, data: { user_id: seerSession.userId } },
    );
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: seerAuth },
    );

    // Device A: owns the cross-signing identity every other device is judged against.
    const asSession = { available: true, hs, user, pass } as HomeserverSession;
    await login(page, asSession);
    await setUpEncryption(page, pass);

    // Device B: same account, its own crypto store, never signed by that identity.
    const deviceB = await secondaryApp.launch();
    await login(deviceB, asSession);
    await openRoom(deviceB, roomName);
    await deviceB.locator('textarea.composer__input').first().click();
    await deviceB.keyboard.type(body);
    await deviceB.keyboard.press('Enter');
    await expect(deviceB.locator('.msg__text', { hasText: runId })).toBeVisible(
      { timeout: 30_000 },
    );

    // Back on A, the message arrives shielded.
    await secondaryApp.activatePrimary();
    await openRoom(page, roomName);
    await expect(page.locator('.msg__text', { hasText: runId })).toBeVisible({
      timeout: 60_000,
    });
    const shieldRow = page
      .locator('.msg', { has: page.locator('.msg__text', { hasText: body }) })
      .first();
    const shield = shieldRow.locator('[data-testid^="msg-shield-"]');
    await expect(shield).toBeVisible({ timeout: 60_000 });
    const eventId = await shieldRow.getAttribute('data-mid');
    expect(eventId).toBeTruthy();

    // Put a genuine receipt on this exact shielded event. The regression only exists when
    // both controls share a row; a mocked receipt would not prove that the Matrix projection
    // and the real browser layout meet at the same message.
    const receiptResponse = await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/receipt/m.read/${encodeURIComponent(eventId as string)}`,
      { headers: seerAuth, data: {} },
    );
    expect(receiptResponse.ok()).toBe(true);
    const receipts = shieldRow.getByTestId('read-receipts');
    await expect(receipts).toBeVisible({ timeout: 30_000 });
    await expect(receipts).toHaveAttribute('aria-label', new RegExp(seerName));

    // The custom tooltip owns the wording now, so no native one may linger.
    await expect(shield).not.toHaveAttribute('title', /./);
    await expect(shield).toHaveAttribute('tabindex', '0');

    // Keyboard reaches it: brn opens on focus, not only hover.
    await shield.focus();
    const tip = page.getByTestId('msg-shield-tip');
    await expect(tip).toBeVisible({ timeout: 10_000 });
    // Both halves — what was found, and what it means for the reader.
    await expect(tip.locator('.msg__shield-tip-reason')).not.toBeEmpty();
    await expect(tip.locator('.msg__shield-tip-detail')).not.toBeEmpty();
    // Announced to a screen reader as the icon's description while open.
    await expect(shield).toHaveAttribute('aria-describedby', /./);

    // Never overstate a shield: it means the sender couldn't be attributed, not
    // that anyone else read the message.
    expect(await tip.innerText()).not.toMatch(
      /intercept|read by|eavesdrop|compromised|leaked/i,
    );

    // Placement, measured in both writing directions: the shield owns only the content
    // row's trailing column. Receipts span the complete body below it, stay flush with the
    // logical trailing edge, and remain in flow for virtual-row measurement.
    for (const direction of ['ltr', 'rtl'] as const) {
      const geometry = await shield.evaluate(async (shieldEl, dir) => {
        document.documentElement.dir = dir;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );

        const rowEl = shieldEl.closest('.msg');
        const bodyEl = rowEl?.querySelector('.msg__body');
        const contentEl = bodyEl?.querySelector('.msg__content');
        const receiptEl = rowEl?.querySelector('[data-testid=read-receipts]');
        if (!rowEl || !bodyEl || !contentEl || !receiptEl) {
          return null;
        }

        const row = rowEl.getBoundingClientRect();
        const body = bodyEl.getBoundingClientRect();
        const content = contentEl.getBoundingClientRect();
        const shieldBox = shieldEl.getBoundingClientRect();
        const receipt = receiptEl.getBoundingClientRect();
        const overlaps = (a: DOMRect, b: DOMRect): boolean =>
          a.left < b.right &&
          a.right > b.left &&
          a.top < b.bottom &&
          a.bottom > b.top;
        const trailingGap = (box: DOMRect): number =>
          dir === 'rtl' ? box.left - body.left : body.right - box.right;

        return {
          shieldIsBodyChild: shieldEl.parentElement === bodyEl,
          // The receipts are a `display: contents` component, so its host is the grid child.
          receiptIsBodyChild:
            receiptEl.closest('trn-message-receipts')?.parentElement === bodyEl,
          receiptsHostDisplay: getComputedStyle(
            receiptEl.closest('trn-message-receipts')!,
          ).display,
          shieldTrailingGap: trailingGap(shieldBox),
          receiptTrailingGap: trailingGap(receipt),
          contentOverlapsShield: overlaps(content, shieldBox),
          receiptOverlapsContent: overlaps(receipt, content),
          receiptOverlapsShield: overlaps(receipt, shieldBox),
          rowContainsReceipt:
            receipt.top >= row.top - 1 && receipt.bottom <= row.bottom + 1,
        };
      }, direction);

      expect(geometry).not.toBeNull();
      expect(geometry!.shieldIsBodyChild).toBe(true);
      expect(geometry!.receiptIsBodyChild).toBe(true);
      expect(geometry!.receiptsHostDisplay).toBe('contents');
      expect(Math.abs(geometry!.shieldTrailingGap)).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry!.receiptTrailingGap)).toBeLessThanOrEqual(1);
      expect(geometry!.contentOverlapsShield).toBe(false);
      expect(geometry!.receiptOverlapsContent).toBe(false);
      expect(geometry!.receiptOverlapsShield).toBe(false);
      expect(geometry!.rowContainsReceipt).toBe(true);
    }
    await page.evaluate(() => document.documentElement.removeAttribute('dir'));
  });

  test('a message sent without encryption into an encrypted room is marked', async ({
    page,
    secondaryApp,
    request,
  }) => {
    // A second Trinity login for the account that sends the encrypted comparison message.
    test.slow();
    const hs = session.hs as string;
    const room = await setUpSharedRoom(request, hs, 'ne');
    const earlier = `sent before encryption ${room.runId}`;
    const clear = `sent without encryption ${room.runId}`;
    const sealed = `sent with encryption by another account ${room.runId}`;

    // Both are marked. The one sent after encryption was switched on gets the red mark; the
    // one dated before it gets the quieter grey mark, with its own wording.
    await room.sendText('earlier', earlier);
    await room.enableEncryption();
    await room.sendText('clear', clear);

    await login(page, room.readerSession);
    await openRoom(page, room.roomName);
    const red = '[data-testid="msg-shield-unencrypted"]';
    const grey = '[data-testid="msg-shield-unencrypted-history"]';
    await expect(rowOf(page, clear)).toBeVisible({ timeout: 30_000 });
    const redShield = rowOf(page, clear).locator(red);
    await expect(redShield).toBeVisible({ timeout: 30_000 });
    await expect(redShield).toHaveAttribute('aria-label', 'Not encrypted');
    await expect(redShield).toHaveClass(/msg__shield--red/);
    await redShield.focus();
    await expect(page.getByTestId('msg-shield-tip')).toContainText(
      'This message was sent without end-to-end encryption.',
    );
    await expect(rowOf(page, clear).locator(grey)).toHaveCount(0);
    // Close the red mark's tooltip, so the next one is the only one open.
    await redShield.blur();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('msg-shield-tip')).toHaveCount(0);

    await expect(rowOf(page, earlier)).toBeVisible();
    const greyShield = rowOf(page, earlier).locator(grey);
    await expect(greyShield).toBeVisible();
    await expect(greyShield).toHaveAttribute('aria-label', 'Not encrypted');
    await expect(greyShield).not.toHaveClass(/msg__shield--red/);
    // Its open-lock glyph differs from both the red mark and the unverified-device caution.
    const glyph = async (shield: typeof greyShield) =>
      shield.locator('svg').evaluate((svg) => svg.innerHTML);
    expect(await glyph(greyShield)).not.toBe(await glyph(redShield));
    await expect(rowOf(page, earlier).locator(red)).toHaveCount(0);
    await greyShield.focus();
    await expect(page.getByTestId('msg-shield-tip')).toContainText(
      'This message is dated before the room turned on end-to-end encryption.',
    );

    // A message another account encrypts is not marked.
    const other = await secondaryApp.launch();
    await login(other, room.ownerSession);
    await openRoom(other, room.roomName);
    await other.locator('textarea.composer__input').first().click();
    await other.keyboard.type(sealed);
    await other.keyboard.press('Enter');
    await expect(other.locator('.msg__text', { hasText: sealed })).toBeVisible({
      timeout: 30_000,
    });
    await secondaryApp.activatePrimary();
    await expect(rowOf(page, sealed)).toBeVisible({ timeout: 60_000 });
    await expect(
      rowOf(page, sealed).locator('[data-testid^="msg-shield-unencrypted"]'),
    ).toHaveCount(0);
    await expect(page.locator(red)).toHaveCount(1);
    await expect(page.locator(grey)).toHaveCount(1);
  });

  // An event with a state key is room state, whatever its type. A state-keyed
  // `m.room.message` must not show up as a message row, marked or not.
  test('a state event of a message type is not shown as a message', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await setUpSharedRoom(request, hs, 'sk');
    const keyed = `state keyed message ${room.runId}`;
    const after = `sent after the state event ${room.runId}`;

    await room.enableEncryption();
    const put = await request.put(`${room.roomUrl}/state/m.room.message/x`, {
      headers: room.ownerAuth,
      data: { msgtype: 'm.text', body: keyed },
    });
    expect(put.ok()).toBe(true);
    await room.sendText('after', after);

    await login(page, room.readerSession);
    await openRoom(page, room.roomName);
    // A row that would have rendered sits before this one, so once it is shown the state
    // event has been through the timeline.
    await expect(rowOf(page, after)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.msg', { hasText: keyed })).toHaveCount(0);
  });

  // The SDK shows an edit's text without checking that the edit was encrypted, so the edit
  // is judged, not the message it replaces.
  test('an unencrypted edit of an encrypted message is marked', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await setUpSharedRoom(request, hs, 'ed');
    const sealed = `sent with encryption ${room.runId}`;
    const edited = `edited without encryption ${room.runId}`;

    await room.enableEncryption();
    await login(page, room.readerSession);
    await openRoom(page, room.roomName);
    await page.locator('textarea.composer__input').first().click();
    await page.keyboard.type(sealed);
    await page.keyboard.press('Enter');

    // Wait for the server's echo, so the row is the sent message rather than a local one.
    const row = rowOf(page, sealed);
    await expect(row).toHaveAttribute('data-mid', /^\$/, { timeout: 30_000 });
    await expect(
      row.locator('[data-testid="msg-shield-unencrypted"]'),
    ).toHaveCount(0);
    const eventId = (await row.getAttribute('data-mid')) as string;

    // The same account edits it through the API, in the clear.
    const edit = await request.put(
      `${room.roomUrl}/send/m.room.message/${room.runId}-edit`,
      {
        headers: room.readerAuth,
        data: {
          msgtype: 'm.text',
          body: `* ${edited}`,
          'm.new_content': { msgtype: 'm.text', body: edited },
          'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
        },
      },
    );
    expect(edit.ok()).toBe(true);

    const editedRow = page.locator(`.msg[data-mid="${eventId}"]`);
    await expect(editedRow.locator('.msg__text')).toContainText(edited, {
      timeout: 30_000,
    });
    await expect(
      editedRow.locator('[data-testid="msg-shield-unencrypted"]'),
    ).toBeVisible({ timeout: 30_000 });
  });
});
