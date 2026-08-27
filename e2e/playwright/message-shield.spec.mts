import { test, expect, type Page } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers per-message authenticity shields (message-row `data-testid="msg-shield-*"`):
// that a plaintext room raises none — shields are resolved only for encrypted events —
// and that a genuinely shielded message explains itself.
//
// A shield can only be provoked for real: it takes an encrypted room, a cross-signing
// identity to judge against, and a second device that identity has never signed. That
// is what the second test builds, because nothing cheaper produces the state — the
// unit tests can assert the mapping and the tooltip, but only a live pair of devices
// proves the SDK actually raises a shield here at all.
// Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

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
  await page.waitForURL('**/rooms', { timeout: 30_000 });
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

test.describe('Message authenticity shields', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('a message in a plaintext room shows no shield', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sh`;
    const owner = `shield-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const reader = `shield-reader-${runId}`;
    const readerPass = `${reader}-pass`;
    const roomName = `Plain ${runId}`;
    const body = `plaintext message ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, reader, readerPass);
    const login1 = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: owner },
          password: ownerPass,
        },
      })
      .then((r) => r.json());
    const ownerAuth = { Authorization: `Bearer ${login1.access_token}` };
    const readerLogin = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: reader },
          password: readerPass,
        },
      })
      .then((r) => r.json());
    const readerAuth = { Authorization: `Bearer ${readerLogin.access_token}` };
    const readerId = readerLogin.user_id as string;

    // A plaintext room (no encryption initial_state) — its messages get no shield.
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: ownerAuth,
        data: { name: roomName, preset: 'private_chat', invite: [readerId] },
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
    } as SynapseSession);
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
    const runId = `${Date.now().toString(36)}st`;
    const user = `shield-tip-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Sealed ${runId}`;
    // Long enough to wrap to the row's right edge: the shield must reserve its own
    // column rather than let the text run underneath it.
    const body = `encrypted from an unsigned device ${runId} — long enough that this line wraps all the way across the message body and reaches the right-hand edge of the row`;

    await registerUser(request, user, pass);
    const session1 = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json());

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${session1.access_token}` },
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

    // Device A: owns the cross-signing identity every other device is judged against.
    const asSession = { available: true, hs, user, pass } as SynapseSession;
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
    const shield = page.locator('[data-testid^="msg-shield-"]').first();
    await expect(shield).toBeVisible({ timeout: 60_000 });

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

    // Placement, measured: flush with the row's trailing edge, top-aligned, and
    // clear of the wrapped text.
    const geometry = await page.evaluate(() => {
      const el = document.querySelector('[data-testid^="msg-shield-"]');
      const rowEl = el?.closest('.msg');
      const textEl = rowEl?.querySelector('.msg__text');
      if (!el || !rowEl || !textEl) return null;
      const row = rowEl.getBoundingClientRect();
      const style = getComputedStyle(rowEl);
      const box = el.getBoundingClientRect();
      return {
        rowLevelChild: el.parentElement === rowEl,
        gapToRowEnd: row.right - parseFloat(style.paddingRight) - box.right,
        gapToRowTop: box.top - (row.top + parseFloat(style.paddingTop)),
        overlapsText: box.left < textEl.getBoundingClientRect().right,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.rowLevelChild).toBe(true);
    expect(geometry!.gapToRowEnd).toBeCloseTo(0, 0);
    expect(geometry!.gapToRowTop).toBeLessThanOrEqual(4);
    expect(geometry!.overlapsText).toBe(false);
  });
});
