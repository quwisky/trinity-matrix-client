import { expect, test, type Page } from '../../../fixtures.mts';
import { apiLogin } from '../../../support/account.mts';
import { homeserverSession, login } from '../../../support/app.mts';
import { addUnsignedSession } from '../../../support/cross-signing.mts';
import { openNamedRoom } from '../../../support/message-composer.mts';
import {
  createEncryptedRoom,
  freshAccount,
  setUpEncryption,
} from '../../support/encryption-journey.mts';

// The Sessions row on another member's card. Until Alice verifies Bob, his sessions carry no
// per-session state and the row asks her to verify him. A live emoji verification between two
// clients then shows his cross-signed session as Verified and flags his second session, which
// uploaded keys and was never cross-signed.
// Needs a homeserver; self-skips without one.
const session = homeserverSession();
const STAGE_TIMEOUT = 60_000;
const SPARE_SESSION = 'Spare phone';
const LONG_NAME = 'pixel-9-pro-fold-with-a-very-long-unbroken-device-name-'
  .repeat(2)
  .slice(0, 96);

function stageOf(page: Page): Promise<string | null> {
  return page
    .getByTestId('verify-page')
    .first()
    .getAttribute('data-stage', { timeout: 1_000 })
    .catch(() => null);
}

async function waitForStage(
  page: Page,
  stages: readonly string[],
): Promise<void> {
  await expect
    .poll(() => stageOf(page), { timeout: STAGE_TIMEOUT, intervals: [500] })
    .toMatch(new RegExp(`^(${stages.join('|')})$`));
}

async function openMemberCard(page: Page, name: string): Promise<void> {
  const memberRow = page.locator('[data-testid="member-row"]', {
    hasText: name,
  });
  if (
    !(await memberRow
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    const toggle = page.getByTestId('toggle-members');
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
    } else {
      await page.getByTestId('room-actions-overflow').click();
      await page.getByTestId('overflow-toggle-members').click();
    }
  }
  await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });
  await memberRow.first().click();
  await expect(page.getByTestId('member-info')).toBeVisible({
    timeout: 10_000,
  });
}

test.describe('Sessions on a member card', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('lists an unverified member plainly, and shows the states once verified', async ({
    page,
    secondaryApp,
    request,
  }) => {
    test.slow();
    const hs = session.hs as string;
    const alice = await freshAccount(request, hs, 'sessions-alice');
    const bob = await freshAccount(request, hs, 'sessions-bob');
    const bobName = `Bob ${bob.user}`;
    const aliceApi = await apiLogin(request, hs, alice.user, alice.pass);
    const bobApi = await apiLogin(request, hs, bob.user, bob.pass);
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(bobApi.userId)}/displayname`,
      { headers: bobApi.headers, data: { displayname: bobName } },
    );

    const roomName = `Sessions ${bob.user}`;
    const roomId = await createEncryptedRoom(request, hs, aliceApi, roomName);
    const roomUrl = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
    await request.post(`${roomUrl}/invite`, {
      headers: aliceApi.headers,
      data: { user_id: bobApi.userId },
    });
    await request.post(`${roomUrl}/join`, { headers: bobApi.headers });

    // The verification request travels in a DM, so it has to be one Bob has already joined.
    const dmId = await createEncryptedRoom(
      request,
      hs,
      aliceApi,
      `Sessions DM ${bob.user}`,
    );
    const dmUrl = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(dmId)}`;
    await request.post(`${dmUrl}/invite`, {
      headers: aliceApi.headers,
      data: { user_id: bobApi.userId },
    });
    await request.post(`${dmUrl}/join`, { headers: bobApi.headers });
    await request.put(
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(aliceApi.userId)}/account_data/m.direct`,
      {
        headers: aliceApi.headers,
        data: { [bobApi.userId]: [dmId] },
      },
    );

    await login(page, alice.asSession);
    await setUpEncryption(page, alice.pass);

    const bobPage = await secondaryApp.launch();
    await login(bobPage, bob.asSession);
    await setUpEncryption(bobPage, bob.pass);
    await addUnsignedSession(request, hs, bob.user, bob.pass, SPARE_SESSION);
    await secondaryApp.activatePrimary();

    // Not verified: the sessions by name, nothing about each, and the prompt in his room name.
    await openNamedRoom(page, roomName);
    await openMemberCard(page, bobName);
    const toggle = page.getByTestId('member-info-sessions-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('member-info-sessions-count')).toHaveText(
      '2 sessions',
      { timeout: 30_000 },
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const sessions = page.getByTestId('member-info-session');
    await expect(sessions.filter({ hasText: SPARE_SESSION })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(page.getByTestId('member-info-session-state')).toHaveCount(0);
    await expect(page.getByTestId('member-info-sessions-prompt')).toHaveText(
      `Verify ${bobName} to check their sessions`,
    );

    // A real emoji verification, started from the card.
    await page.getByTestId('member-info-verify').click();
    await waitForStage(bobPage, ['requested']);
    await bobPage.getByTestId('verify-accept').click();
    await waitForStage(page, ['ready', 'waiting', 'sas-shown']);
    await waitForStage(bobPage, ['ready', 'waiting', 'sas-shown']);
    if (
      (await stageOf(page)) !== 'sas-shown' &&
      (await stageOf(bobPage)) !== 'sas-shown'
    ) {
      const starter = await Promise.race(
        [page, bobPage].map((device) =>
          device
            .getByTestId('verify-start-sas')
            .waitFor({ state: 'visible', timeout: STAGE_TIMEOUT })
            .then(
              () => device,
              () => null,
            ),
        ),
      );
      if (!starter) throw new Error('Neither client offered the emoji check.');
      await starter.getByTestId('verify-start-sas').click();
    }
    await waitForStage(page, ['sas-shown']);
    await waitForStage(bobPage, ['sas-shown']);
    await page.getByTestId('sas-match').click();
    await bobPage.getByTestId('sas-match').click();
    await waitForStage(page, ['done']);
    await page
      .getByTestId('verify-page')
      .getByRole('button', { name: 'Done' })
      .click();

    // Verified: his cross-signed session reads Verified, and the spare is flagged, first.
    await openNamedRoom(page, roomName);
    await openMemberCard(page, bobName);
    await expect(page.getByTestId('member-info-trust')).toHaveText(/Verified/, {
      timeout: 30_000,
    });
    await page.getByTestId('member-info-sessions-toggle').click();
    await expect(sessions.first()).toContainText(SPARE_SESSION);
    await expect(sessions.first()).toContainText('Not verified');
    await expect(sessions.last()).toContainText('Verified');
    await expect(sessions.last()).not.toContainText('Not verified');
    await expect(sessions).toHaveCount(2);
    await expect(page.getByTestId('member-info-sessions-count')).toHaveText(
      '2 sessions · 1 not verified',
    );
    await expect(page.getByTestId('member-info-sessions-prompt')).toHaveCount(
      0,
    );
  });

  test('a long list scrolls inside the card and an unbroken name wraps, at phone width', async ({
    page,
    request,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 390, height: 844 });
    const hs = session.hs as string;
    const alice = await freshAccount(request, hs, 'sessions-alice');
    const dana = await freshAccount(request, hs, 'sessions-dana');
    const aliceApi = await apiLogin(request, hs, alice.user, alice.pass);
    const danaApi = await apiLogin(request, hs, dana.user, dana.pass);
    const roomName = `Sessions ${dana.user}`;
    const roomId = await createEncryptedRoom(request, hs, aliceApi, roomName);
    const roomUrl = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
    await request.post(`${roomUrl}/invite`, {
      headers: aliceApi.headers,
      data: { user_id: danaApi.userId },
    });
    await request.post(`${roomUrl}/join`, { headers: danaApi.headers });
    await addUnsignedSession(request, hs, dana.user, dana.pass, LONG_NAME);
    for (let i = 1; i <= 8; i++) {
      await addUnsignedSession(
        request,
        hs,
        dana.user,
        dana.pass,
        `Tablet ${i}`,
      );
    }

    await login(page, alice.asSession);
    await openNamedRoom(page, roomName);
    await openMemberCard(page, dana.user);
    await page.getByTestId('member-info-sessions-toggle').click();
    await expect(page.getByTestId('member-info-session')).toHaveCount(9, {
      timeout: 30_000,
    });

    const list = page.getByTestId('member-info-sessions-list');
    await expect
      .poll(() =>
        list.evaluate((el) => ({
          scrollsInside: el.scrollHeight > el.clientHeight,
          fitsAcross: el.scrollWidth <= el.clientWidth,
        })),
      )
      .toEqual({ scrollsInside: true, fitsAcross: true });
    // A flush row draws its focus ring inside, not over the dividers around it.
    const row = page.getByTestId('member-info-sessions-toggle');
    await row.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(row).toBeFocused();
    expect(
      await row.evaluate(
        (el) => Number.parseFloat(getComputedStyle(el).outlineOffset) < 0,
      ),
    ).toBe(true);
    await page.keyboard.press('Tab');
    await expect(list).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
});
