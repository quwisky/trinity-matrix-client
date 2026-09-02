import { expect, test, testResourceId } from '../../../fixtures.mts';
import { login } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  addAccountViaUi,
  apiLogin,
  configureMultiAccountSuite,
  mixInAccount,
  session,
} from '../../support/multi-account-journey.mts';

test.describe('Multiple accounts', () => {
  configureMultiAccountSuite();

  test('mixed view shows both accounts’ rooms, badged, and opening one switches account', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}mx`;
    const userA = `mixed-a-${runId}`;
    const passA = `mixed-a-pass-${runId}`;
    const userB = `mixed-b-${runId}`;
    const passB = `mixed-b-pass-${runId}`;
    const roomA = `Room A ${runId}`;
    const roomB = `Room B ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    const b = await apiLogin(request, hs, userB, passB);
    for (const [who, name] of [
      [a, roomA],
      [b, roomB],
    ] as const) {
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: who.headers,
        data: { name, preset: 'private_chat' },
      });
    }

    // Sign in A, then add B (B becomes the active account) — both now signed in.
    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // Recent is the default view. Only the active account (B) is shown until A is
    // ticked into the mix via the user panel's account picker.
    const roomARow = page.locator('.channel', { hasText: roomA });
    const roomBRow = page.locator('.channel', { hasText: roomB });
    await expect(roomBRow).toBeVisible({ timeout: 20_000 });
    await expect(roomARow).toHaveCount(0); // A's room is on the other account
    await mixInAccount(page, userA);

    // Now both accounts' rooms are listed, each carrying an account badge.
    await expect(roomARow).toBeVisible({ timeout: 20_000 });
    await expect(roomBRow).toBeVisible();
    await expect(
      roomARow.locator('[data-testid="account-badge"]'),
    ).toBeVisible();

    // Opening A's room switches the active account to A and opens it.
    await roomARow.click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`, {
      timeout: 20_000,
    });
    await expect(
      page.locator('trn-channel-sidebar .channel.active', { hasText: roomA }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('mixed view shows both accounts’ space pills, badged, and opening one switches account', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sp`;
    const userA = `msp-a-${runId}`;
    const passA = `msp-a-pass-${runId}`;
    const userB = `msp-b-${runId}`;
    const passB = `msp-b-pass-${runId}`;
    const spaceA = `Space A ${runId}`;
    const spaceB = `Space B ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    const b = await apiLogin(request, hs, userB, passB);
    // Each account creates a space (a room with creation_content.type: m.space).
    for (const [who, name] of [
      [a, spaceA],
      [b, spaceB],
    ] as const) {
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: who.headers,
        data: {
          name,
          preset: 'private_chat',
          creation_content: { type: 'm.space' },
        },
      });
    }

    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    const railPill = (name: string) =>
      page.locator('trn-server-rail').getByRole('button', { name });

    // Only the active account (B) is mixed in by default, so only its pill is in the rail.
    await expect(railPill(spaceB)).toBeVisible({ timeout: 20_000 });
    await expect(railPill(spaceA)).toHaveCount(0);

    // Tick A into the mix → both accounts' space pills show, each badged.
    await mixInAccount(page, userA);
    await expect(railPill(spaceA)).toBeVisible({ timeout: 20_000 });
    await expect(
      railPill(spaceA).locator('[data-testid="account-badge"]'),
    ).toBeVisible();

    // Opening A's space switches the active account to A.
    await railPill(spaceA).click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`, {
      timeout: 20_000,
    });
  });
  // The picker's headline promises: the mix survives a restart, the account you're acting
  // as can't be dropped, and unticking really puts the view back to one account. Those are
  // all persisted/stateful behaviours that unit tests can only assert against a mock.
  test('the account mix persists across a reload, locks the active account, and can be turned off', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}pk`;
    const userA = `pick-a-${runId}`;
    const passA = `pick-a-pass-${runId}`;
    const userB = `pick-b-${runId}`;
    const passB = `pick-b-pass-${runId}`;
    const roomA = `Room A ${runId}`;
    const roomB = `Room B ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    const b = await apiLogin(request, hs, userB, passB);
    for (const [who, name] of [
      [a, roomA],
      [b, roomB],
    ] as const) {
      await request.post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: who.headers,
        data: { name, preset: 'private_chat' },
      });
    }

    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    const roomARow = page.locator('.channel', { hasText: roomA });
    const roomBRow = page.locator('.channel', { hasText: roomB });
    await expect(roomBRow).toBeVisible({ timeout: 20_000 });

    await mixInAccount(page, userA);
    await expect(roomARow).toBeVisible({ timeout: 20_000 });
    // While mixing, the footer states the mix size and stacks the accounts' avatars.
    await expect(page.getByTestId('account-stack')).toBeVisible();
    await expect(page.getByTestId('account-stack-count')).toContainText(
      '2 accounts',
    );

    // The selection is persisted, so a cold reload comes back mixed rather than resetting.
    await page.reload();
    await expect(roomARow).toBeVisible({ timeout: 30_000 });
    await expect(roomBRow).toBeVisible();

    // The account being acted as is always shown: its picker row is present but disabled,
    // so it cannot be unticked.
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('show-accounts').click();
    const activeRow = page.locator(`[data-testid^="show-account-@${userB}:"]`);
    await expect(activeRow).toHaveAttribute('aria-checked', 'true');
    await expect(activeRow).toHaveAttribute('data-disabled', '');
    await expect(activeRow).toHaveCSS('opacity', '1');

    // Unticking the other account returns the view to a single account.
    await page.locator(`[data-testid^="show-account-@${userA}:"]`).click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(roomARow).toHaveCount(0);
    await expect(roomBRow).toBeVisible();
    await expect(page.getByTestId('account-stack')).toHaveCount(0);
  });
  // The quick switcher shares the picker's scope, so it must find another account's rooms
  // and switch to that account on the jump — the same contract as clicking a sidebar row.
  // Issue #28. Below the md breakpoint a submenu has nowhere to fly out to — it would land
  // back on top of the account menu — so the picker is a dialog there instead. The suite runs
  // a single desktop project, so this test resizes rather than adding a whole project.
  test('narrow layout picks accounts in a dialog rather than a submenu', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}nrw`;
    const userA = `narrow-a-${runId}`;
    const passA = `narrow-a-pass-${runId}`;
    const userB = `narrow-b-${runId}`;
    const passB = `narrow-b-pass-${runId}`;
    const roomA = `Narrow A ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: a.headers,
      data: { name: roomA, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);

    // A phone-sized viewport. With no room open the sidebar is the full-screen page, so the
    // user panel is a bar across the bottom — the worst case for a flyout.
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('show-accounts').click();

    // A dialog, not a submenu: the account menu is gone by now.
    const picker = page.getByTestId('account-picker');
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(picker).toHaveCSS('display', 'flex');
    await expect(picker.locator('.picker__list')).toHaveCSS(
      'overflow-y',
      'auto',
    );
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible();

    // The same row contract the desktop submenu carries.
    const activeRow = page.locator(`[data-testid^="show-account-@${userB}:"]`);
    await expect(activeRow).toHaveAttribute('aria-checked', 'true');
    await expect(activeRow).toHaveAttribute('data-disabled', '');
    await expect(activeRow).toHaveCSS('opacity', '1');

    // Ticking applies immediately and does NOT close the picker — it is a multi-select.
    const otherRow = page.locator(`[data-testid^="show-account-@${userA}:"]`);
    await otherRow.click();
    await expect(otherRow).toHaveAttribute('aria-checked', 'true');
    await expect(picker).toBeVisible();

    await page.getByTestId('account-picker-done').click();
    await expect(picker).toHaveCount(0);

    // The mix took effect: A's room is now listed alongside B's.
    await expect(page.locator('.channel', { hasText: roomA })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('the quick switcher finds a mixed-in account’s room and switches to it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}qs`;
    const userA = `qs-a-${runId}`;
    const passA = `qs-a-pass-${runId}`;
    const userB = `qs-b-${runId}`;
    const passB = `qs-b-pass-${runId}`;
    // A distinctive name so the switcher query cannot match anything else.
    const roomA = `Zephyr ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    const a = await apiLogin(request, hs, userA, passA);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: a.headers,
      data: { name: roomA, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user: userA, pass: passA });
    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);
    await expect(page.locator('.channel', { hasText: roomA })).toHaveCount(0);

    // Not mixed yet: the switcher searches the active account only, so A's room is absent.
    await page.getByTestId('open-switcher').click();
    await page.getByTestId('switcher-input').fill('Zephyr');
    await expect(page.getByTestId('switcher-result')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Tick A in, and the same query now finds its room, badged with the owning account.
    await mixInAccount(page, userA);
    await page.getByTestId('open-switcher').click();
    await page.getByTestId('switcher-input').fill('Zephyr');
    const hit = page.getByTestId('switcher-result').filter({ hasText: roomA });
    await expect(hit).toBeVisible({ timeout: 20_000 });
    await expect(hit.locator('[data-testid="account-badge"]')).toBeVisible();

    // Jumping to it switches the active account to A and opens the room.
    await hit.click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`, {
      timeout: 20_000,
    });
    await expect(
      page.locator('trn-channel-sidebar .channel.active', { hasText: roomA }),
    ).toBeVisible({ timeout: 15_000 });
  });

  // Two things unit tests cannot reach: an invite addressed to an account you are only
  // SHOWING (it must be visible and answerable without switching), and the header chip that
  // names the identity you are acting as after a cross-account open.
  test('shows a mixed-in account’s invite and names the acting identity in the header', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}iv`;
    const userA = `inv-a-${runId}`;
    const passA = `inv-a-pass-${runId}`;
    const userB = `inv-b-${runId}`;
    const passB = `inv-b-pass-${runId}`;
    const host = `inv-h-${runId}`;
    const passH = `inv-h-pass-${runId}`;
    const roomA = `Room A ${runId}`;
    const invited = `Invited ${runId}`;

    await registerUser(request, userA, passA);
    await registerUser(request, userB, passB);
    await registerUser(request, host, passH);
    const a = await apiLogin(request, hs, userA, passA);
    const b = await apiLogin(request, hs, userB, passB);
    const h = await apiLogin(request, hs, host, passH);

    // Display names deliberately NOT substrings of the mxids. Every profile assertion in
    // this file used the localpart, which IS a substring of `@localpart:localhost` — so it
    // passed against an account whose profile never hydrated, which is exactly what the
    // account-profile projection exists to prevent.
    const nameA = `Alpha ${runId}`;
    const nameB = `Bravo ${runId}`;
    for (const [who, name] of [
      [a, nameA],
      [b, nameB],
    ] as const) {
      await request.put(
        `${hs}/_matrix/client/v3/profile/${encodeURIComponent(who.userId)}/displayname`,
        { headers: who.headers, data: { displayname: name } },
      );
    }

    // A owns a room (so the mixed list has something of A's), and a third party invites A
    // to another room — the invite therefore belongs to an account that will NOT be active.
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: a.headers,
      data: { name: roomA, preset: 'private_chat' },
    });
    // B needs a room of its own for its profile to reach the client at all: the SDK
    // hydrates `getUser()` from presence, and an account in no rooms receives none — so
    // without this the panel would show B's mxid however well the projection works, and
    // the assertion below would be testing the SDK rather than this code.
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: b.headers,
      data: { name: `Room B ${runId}`, preset: 'private_chat' },
    });
    const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: h.headers,
      data: { name: invited, preset: 'private_chat' },
    });
    const invitedRoomId = (await created.json()).room_id as string;
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(invitedRoomId)}/invite`,
      { headers: h.headers, data: { user_id: `@${userA}:localhost` } },
    );

    await login(page, { available: true, hs, user: userA, pass: passA });
    // A's OWN profile, hydrated from its own sync. The client seeds its own user with a
    // plain `new User(id)` and no re-emitter, so nothing but the sync tick can deliver
    // this — without it the panel shows the raw mxid for the whole session.
    await expect(page.locator('.userbar__name')).toHaveText(nameA, {
      timeout: 20_000,
    });

    await addAccountViaUi(page, hs, userB, passB);
    await expect(page.locator('.userbar__handle')).toContainText(`@${userB}:`);
    // B's profile arrives through B's OWN client — one listener per account, not one on
    // whichever account happens to be active.
    await expect(page.locator('.userbar__name')).toHaveText(nameB, {
      timeout: 20_000,
    });

    // Active account is B, so A's invite is invisible until A is mixed in.
    await expect(page.locator('.invite', { hasText: invited })).toHaveCount(0);

    await mixInAccount(page, userA);
    const inviteRow = page.locator('.invite', { hasText: invited });
    await expect(inviteRow).toBeVisible({ timeout: 20_000 });
    await expect(
      inviteRow.locator('[data-testid="account-badge"]'),
    ).toBeVisible();

    // Opening one of A's rooms switches the acting identity — and says so in the header.
    await page.locator('.channel', { hasText: roomA }).click();
    await expect(page.locator('.userbar__handle')).toContainText(`@${userA}:`, {
      timeout: 20_000,
    });
    const chip = page.getByTestId('active-account-chip');
    await expect(chip).toBeVisible();
    // Scoped to the name span (the chip also renders an avatar initial), and paired with a
    // negative: `toHaveText` alone still passes if the chip names the WRONG account, while
    // the `not.toContainText` is what rules out the mxid fallback.
    await expect(chip.locator('.title-account__name')).toHaveText(nameA, {
      timeout: 20_000,
    });
    await expect(chip).not.toContainText(`@${userA}:`);
  });
});
