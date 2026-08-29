import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from './support/fixtures.mts';
import {
  isAndroidE2E,
  login,
  synapseSession,
  type SynapseSession,
} from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers the member info panel: clicking a member row in the member list
// (data-testid="member-row") opens a room-scoped info panel
// (data-testid="member-info") with the member's name, id, role, and a Message /
// Copy user ID action. Two users so there's a member to click that isn't the
// viewer. Needs a Synapse homeserver (Docker); self-skips otherwise.
const session = synapseSession();

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

test.describe('Member info panel', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('clicking a member opens their info panel', async ({
    context,
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}mi`;
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
    } as SynapseSession);
    await openRoom(page, roomName);

    // The member list is open by default — click the member's row.
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

    await memberRow.first().click();

    // The info panel opens with their name, id, role, and a Message action.
    const panel = page.getByTestId('member-info');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await expect(panel.getByTestId('member-info-name')).toHaveText(memberName);
    await expect(panel).toContainText(memberB.userId);
    await expect(panel).toContainText('Member');
    await expect(panel.getByTestId('member-info-message')).toBeVisible();

    // The slot supplies position and size only, so the component has to paint its own
    // surface — otherwise this is a transparent 480px column with a small card floating in
    // it, swallowing every click on the timeline behind. Measured in a real browser because
    // that is the only place `:host` and the page's `.chat-panel` rule meet.
    const surface = await page.locator('trn-member-info').evaluate((host) => {
      const style = getComputedStyle(host);
      return {
        display: style.display,
        background: style.backgroundColor,
        height: host.getBoundingClientRect().height,
        // The row the panel shares with the timeline, which is what "full height" means for
        // a pane IN FLOW. Not the viewport: the row starts below the room header, so a
        // viewport-relative bound would be measuring the header, and would answer
        // differently again if the panel ever went back to being an overlay.
        row: host.closest('.chat-body')?.getBoundingClientRect().height ?? 0,
      };
    });
    expect(surface.display).toBe('flex');
    expect(surface.background).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    // As tall as the pane beside it, not a content-sized card floating in the slot.
    expect(surface.row).toBeGreaterThan(0);
    expect(Math.abs(surface.height - surface.row)).toBeLessThanOrEqual(1);

    // Exercise the platform clipboard rather than stubbing writeText: the unique full MXID
    // must paste back exactly, while the deliberately different display name must not.
    // Desktop browsers model the user's clipboard-write choice as a context permission;
    // Android's installed WebView uses its native foreground clipboard path instead.
    if (!isAndroidE2E) {
      await context.grantPermissions(['clipboard-write'], {
        origin: new URL(page.url()).origin,
      });
    }
    await page.getByTestId('member-info-copy').click();
    await expect(
      page.getByText('User ID copied.', { exact: true }),
    ).toBeVisible();
    const clipboardProbe = page.locator('[data-testid=clipboard-probe]');
    await page.evaluate(() => {
      const probe = document.createElement('input');
      probe.dataset['testid'] = 'clipboard-probe';
      probe.style.position = 'fixed';
      probe.style.inset = '0 auto auto 0';
      document.body.append(probe);
    });
    await clipboardProbe.focus();
    await page.keyboard.press('Control+V');
    await expect(clipboardProbe).toHaveValue(memberB.userId);
    await clipboardProbe.evaluate((node) => node.remove());

    // And it can be closed. As a dialog the backdrop and Escape do that; in the slot at this
    // width there is neither, so without the header's button the panel is a dead end.
    // From the page, not the panel: the header is a SIBLING of `member-info`, which is the
    // body card — the component's host is what wraps both.
    await page.getByTestId('member-info-close').click();
    await expect(panel).toBeHidden({ timeout: 10_000 });
    // Closing member info gives the roster back rather than emptying the slot.
    await expect(
      page.locator('[data-testid="member-row"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
