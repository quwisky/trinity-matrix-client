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
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';

// Covers member info: clicking a member row in the member list
// (data-testid="member-row") opens a room-scoped info card
// (data-testid="member-info") with the member's name, id, role, and a Message /
// Copy user ID action. It is a centred dialog on a large screen and a bottom sheet
// on a phone-sized window, over the member list either way (#1041). Two users so
// there's a member to click that isn't the viewer. Needs a Synapse homeserver
// (Docker); self-skips otherwise.
const session = homeserverSession();

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

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

async function openMembers(page: Page): Promise<void> {
  const toggle = page.getByTestId('toggle-members');
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
  } else {
    await page.getByTestId('room-actions-overflow').click();
    await page.getByTestId('overflow-toggle-members').click();
  }
  await expect(page.locator('.chat-members')).toBeVisible();
}

test.describe('Member info', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('clicking a member opens their info over the member list', async ({
    context,
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}mi`;
    const adminUser = `mi-admin-${runId}`;
    const adminPass = `${adminUser}-pass`;
    const memberUser = `mi-member-${runId}`;
    const memberPass = `${memberUser}-pass`;
    const roomName = `Members ${runId}`;
    const memberName = `Member ${runId}`;

    await registerUser(request, adminUser, adminPass);
    await registerUser(request, memberUser, memberPass);
    const admin = await apiLogin(request, hs, adminUser, adminPass);
    const memberB = await apiLogin(request, hs, memberUser, memberPass);

    // The member sets a display name so their row is identifiable.
    await request.put(
      `${hs}/_matrix/client/v3/profile/${encodeURIComponent(memberB.userId)}/displayname`,
      { headers: memberB.headers, data: { displayname: memberName } },
    );

    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: admin.headers,
        data: {
          name: roomName,
          preset: 'private_chat',
          invite: [memberB.userId],
        },
      })
      .then((r) => r.json());
    await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/join`,
      { headers: memberB.headers },
    );

    await login(page, {
      available: true,
      hs,
      user: adminUser,
      pass: adminPass,
    } as HomeserverSession);
    await openRoom(page, roomName);
    await expect(page.locator('.chat-members')).toBeHidden();
    await openMembers(page);

    // The member list is explicit shell state — open it before selecting a row.
    const memberRow = page.locator('[data-testid="member-row"]', {
      hasText: memberName,
    });
    await memberRow.first().waitFor({ state: 'visible', timeout: 20_000 });

    // The member list windows itself, and its spacer heights come from a ROW_PX constant
    // rather than a measurement — jsdom has no layout, so the unit tests can only check
    // that the arithmetic is self-consistent, not that the number is right. If a row stops
    // being 44px the spacers drift and the scrollbar lies about how long the list is, with
    // nothing in the unit suite to say so. Measured here, where there is a real cascade.
    const rowBox = await memberRow.first().boundingBox();
    expect(rowBox?.height).toBe(44);

    // The header height too, and for a sharper reason: the unit test that checks the
    // spacer arithmetic is algebraically blind to it — the bottom spacer comes out of the
    // same total, so the header's height cancels whatever value it is given. Nothing but a
    // real cascade can say whether HEADER_PX matches what the stylesheet renders.
    const headerBox = await page
      .locator('.members__section-label')
      .first()
      .boundingBox();
    expect(headerBox?.height).toBe(34);

    // The button recipe sets its own height (32px on a coarse pointer), and the windowing
    // needs 44px at every breakpoint — so measure again on a phone-sized viewport.
    const desktopViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    // Becoming a drawer closes the remembered roster, in an effect after the resize — so
    // wait for that rather than reading visibility before it has run.
    await expect(page.locator('.chat-members')).toBeHidden();
    await openMembers(page);
    await memberRow.first().waitFor({ state: 'visible' });
    expect((await memberRow.first().boundingBox())?.height).toBe(44);
    await page.setViewportSize(desktopViewport);
    await expect(page.locator('.chat-members')).toBeVisible();

    await memberRow.first().click();

    // Member info is a centred dialog on a large screen, on top of the member list rather
    // than in its place (#1041): the column stays where it was behind the dialog.
    const dialog = page.getByRole('dialog', { name: 'Member info' });
    const panel = dialog.getByTestId('member-info');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByTestId('dialog-surface')).toHaveAttribute(
      'data-trn-layout',
      'dialog',
    );
    await expect(dialog.getByTestId('sheet-handle')).toHaveCount(0);
    await expect(page.locator('.chat-members')).toBeVisible();
    await expect(page.locator('.chat-body trn-member-info')).toHaveCount(0);
    await expect(panel.getByTestId('member-info-name')).toHaveText(memberName);
    await expect(panel.getByTestId('member-info-handle')).toHaveText(
      memberB.userId,
    );
    await expect(panel).toContainText('Member');
    await expect(panel.getByTestId('member-info-message')).toBeVisible();

    // The card keeps its bottom padding: the last action does not sit on the dialog's edge.
    const bottomGap = await panel.evaluate((card) => {
      const buttons = card.querySelectorAll('button');
      const last = buttons[buttons.length - 1];
      return (
        card.getBoundingClientRect().bottom -
        last.getBoundingClientRect().bottom
      );
    });
    expect(bottomGap).toBeGreaterThanOrEqual(12);
    // "Remove from room" reads as a danger action, not in the neutral text colour.
    const kickColour = await panel
      .getByTestId('member-info-kick')
      .evaluate((button) => getComputedStyle(button).color);
    const copyColour = await panel
      .getByTestId('member-info-copy')
      .evaluate((button) => getComputedStyle(button).color);
    expect(kickColour).not.toBe(copyColour);

    // Exercise the platform clipboard rather than stubbing writeText: the unique full MXID
    // must paste back exactly, while the deliberately different display name must not.
    // Browsers model the user's clipboard-write choice as a context permission.
    await context.grantPermissions(['clipboard-write'], {
      origin: new URL(page.url()).origin,
    });

    await panel.getByTestId('member-info-copy').click();
    await expect(
      page.getByText('User ID copied.', { exact: true }),
    ).toBeVisible();

    // The X closes it back to the list, and focus returns to the row that opened it.
    await dialog.getByTestId('member-info-close').click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('.chat-members')).toBeVisible();
    await expect(memberRow.first()).toBeFocused();

    const clipboardProbe = page.locator('[data-testid=clipboard-probe]');
    await page.evaluate(() => {
      const probe = document.createElement('input');
      probe.dataset['testid'] = 'clipboard-probe';
      probe.style.position = 'fixed';
      probe.style.inset = '0 auto auto 0';
      document.body.append(probe);
    });
    await clipboardProbe.focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(clipboardProbe).toHaveValue(memberB.userId);
    await clipboardProbe.evaluate((node) => node.remove());

    // Escape closes the dialog and only the dialog.
    await memberRow.first().click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('.chat-members')).toBeVisible();

    // On a phone-sized window it is a bottom sheet over the member drawer, with the handle;
    // dragging the handle down closes the sheet and leaves the drawer open.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.chat-members')).toBeHidden();
    await openMembers(page);
    await memberRow.first().click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByTestId('dialog-surface')).toHaveAttribute(
      'data-trn-layout',
      'sheet',
    );
    const handle = dialog.getByTestId('sheet-handle');
    await expect(handle).toBeVisible();
    await expect(page.locator('.chat-members')).toBeVisible();
    await expect(page.getByTestId('members-backdrop')).toBeVisible();

    // Escape on the sheet closes the sheet, not the drawer under it as well.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('.chat-members')).toBeVisible();

    await memberRow.first().click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    // The sheet slides up on entry; drag once it has settled at the bottom edge.
    await expect
      .poll(async () => {
        const box = await dialog.getByTestId('dialog-surface').boundingBox();
        return Math.abs((box?.y ?? 0) + (box?.height ?? 0) - 844);
      })
      .toBeLessThanOrEqual(1);
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 150, { steps: 5 });
    await page.mouse.move(x, y + 300, { steps: 5 });
    await page.mouse.up();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('.chat-members')).toBeVisible();
    await expect(memberRow.first()).toBeVisible();

    // "Message" closes the sheet and opens the direct message with them.
    await memberRow.first().click();
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await panel.getByTestId('member-info-message').click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    // The title carries the avatar initial before the name.
    await expect(page.getByTestId('room-title')).toContainText(memberName, {
      timeout: 30_000,
    });
  });
});
