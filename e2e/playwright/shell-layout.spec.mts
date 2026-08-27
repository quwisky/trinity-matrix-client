import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from './support/fixtures.mts';
import {
  login,
  seedPreference,
  synapseSession,
  type SynapseSession,
} from './support/app.mts';
import { passwordLogin, registerUser } from './support/account.mts';

/**
 * Rendered Phase 2 shell contract.
 *
 * Source guards pin the recipes, but only a browser can prove that overflowing real Matrix
 * content has one scroll owner per pane and that long labels do not push badges/actions out
 * of their columns. This deliberately seeds all four vertical panes and repeats the layout in
 * Cosy and Compact at the three phase-closing desktop viewports.
 */
const session = synapseSession();
const DENSITY_KEY = 'trinity.density';

interface ApiAccount {
  readonly userId: string;
  readonly headers: { Authorization: string };
}

async function account(
  request: APIRequestContext,
  hs: string,
  username: string,
  password: string,
): Promise<ApiAccount> {
  await registerUser(request, username, password);
  const signedIn = await passwordLogin(request, hs, username, password);
  return {
    userId: signedIn.userId,
    headers: { Authorization: `Bearer ${signedIn.accessToken}` },
  };
}

async function putDisplayName(
  request: APIRequestContext,
  hs: string,
  actor: ApiAccount,
  displayName: string,
): Promise<void> {
  const response = await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(actor.userId)}/displayname`,
    { headers: actor.headers, data: { displayname: displayName } },
  );
  if (!response.ok()) {
    throw new Error(
      `set display name -> ${response.status()} ${await response.text()}`,
    );
  }
}

async function createRoom(
  request: APIRequestContext,
  hs: string,
  actor: ApiAccount,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: actor.headers,
    data,
  });
  if (!response.ok()) {
    throw new Error(
      `create room -> ${response.status()} ${await response.text()}`,
    );
  }
  return ((await response.json()) as { room_id: string }).room_id;
}

async function joinRoom(
  request: APIRequestContext,
  hs: string,
  actor: ApiAccount,
  roomId: string,
): Promise<void> {
  const response = await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: actor.headers },
  );
  if (!response.ok()) {
    throw new Error(
      `join room -> ${response.status()} ${await response.text()}`,
    );
  }
}

async function sendMessages(
  request: APIRequestContext,
  hs: string,
  actor: ApiAccount,
  roomId: string,
  prefix: string,
): Promise<void> {
  for (let index = 0; index < 42; index++) {
    const response = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${prefix}-${index}`,
      {
        headers: actor.headers,
        data: {
          msgtype: 'm.text',
          body: `${prefix} message ${index} with enough text to occupy the timeline`,
        },
      },
    );
    if (!response.ok()) {
      throw new Error(
        `send message -> ${response.status()} ${await response.text()}`,
      );
    }
  }
}

async function expectEllipsis(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const state = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clipped: element.scrollWidth > element.clientWidth,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
    };
  });
  expect(state).toEqual({
    clipped: true,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });
}

async function expectInside(child: Locator, parent: Locator): Promise<void> {
  const [childBox, parentBox] = await Promise.all([
    child.boundingBox(),
    parent.boundingBox(),
  ]);
  expect(childBox).not.toBeNull();
  expect(parentBox).not.toBeNull();
  expect(childBox!.x).toBeGreaterThanOrEqual(parentBox!.x - 1);
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(
    parentBox!.x + parentBox!.width + 1,
  );
}

async function expectScrollContract(
  page: Page,
  viewport: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(viewport);
  // Member virtualization re-renders its owned DOM on resize, so fill after the viewport
  // settles rather than assuming the inert overflow copies survive that render.
  await fillNavigationScrollers(page);

  await expect
    .poll(() =>
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    )
    .toEqual({ clientWidth: viewport.width, scrollWidth: viewport.width });

  const scrollOwners = await page.evaluate(() => {
    const selectors = ['.rail', '.sidebar__scroll', '.scroll', '.members'];
    return selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`missing shell scroll owner ${selector}`);
      return {
        selector,
        overflowY: getComputedStyle(element).overflowY,
        overflows: element.scrollHeight > element.clientHeight + 1,
      };
    });
  });
  expect(scrollOwners).toEqual(
    ['.rail', '.sidebar__scroll', '.scroll', '.members'].map((selector) => ({
      selector,
      overflowY: 'auto',
      overflows: true,
    })),
  );

  const wrapperOverflow = await page.evaluate(() => {
    const selectors = [
      'html',
      'body',
      '[data-shell-root]',
      '.shell-side',
      '.sidebar',
      '.main',
      '.chat-body',
    ];
    return selectors.filter((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element && element.scrollHeight > element.clientHeight + 1;
    });
  });
  expect(wrapperOverflow).toEqual([]);

  await expect(page.locator('.chat-members')).toHaveCSS(
    'position',
    viewport.width >= 1100 ? 'static' : 'fixed',
  );
}

/**
 * Repeat already-rendered navigation rows until their real scrollers overflow. The source
 * room/space/member/message data remains Matrix-backed; the inert copies avoid dozens of
 * unrelated join-rate-limit waits while exercising the same browser boxes and scroll CSS.
 */
async function fillNavigationScrollers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fill = (rootSelector: string, sourceSelector: string) => {
      const root = document.querySelector<HTMLElement>(rootSelector);
      const source = document.querySelector<HTMLElement>(sourceSelector);
      if (!root || !source) throw new Error(`cannot fill ${rootSelector}`);
      let copies = 0;
      while (root.scrollHeight <= root.clientHeight + 100 && copies < 40) {
        const clone = source.cloneNode(true) as HTMLElement;
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('inert', '');
        clone.style.flex = '0 0 auto';
        root.append(clone);
        copies++;
      }
    };
    fill('.rail', '.rail .item');
    fill('.sidebar__scroll', '.sidebar__scroll .channel-row');
    fill('.members', '.members .member');
  });
}

test.describe('Modern room shell layout', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps overflowing panes and long identities safe in both densities', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}sh`;
    const readerName = `shell-${runId}`;
    const readerPass = `${readerName}-pass`;
    const longAccountName = `Alexandria Very Long Account Name ${runId} That Must Truncate`;
    const reader = await account(request, hs, readerName, readerPass);
    await putDisplayName(request, hs, reader, longAccountName);

    const members: ApiAccount[] = [];
    for (let index = 0; index < 8; index++) {
      const username = `shell-member-${index}-${runId}`;
      const participant = await account(
        request,
        hs,
        username,
        `${username}-pass`,
      );
      await putDisplayName(
        request,
        hs,
        participant,
        index === 0
          ? `Morgan With A Member Name Far Too Long For The Roster ${runId}`
          : `Shell member ${index} ${runId}`,
      );
      members.push(participant);
    }

    // Synapse deliberately rate-limits room creation separately from messages. Spread the
    // fixtures across their owning accounts and invite the reader, matching a real account
    // that has joined rooms created by several people rather than weakening the harness.
    const joinedFixture = async (
      owner: ApiAccount,
      data: Record<string, unknown>,
    ): Promise<string> => {
      const roomId = await createRoom(request, hs, owner, {
        ...data,
        invite: [reader.userId],
      });
      await joinRoom(request, hs, reader, roomId);
      return roomId;
    };

    // Representative real Matrix places/rooms; inert copies below provide the repeated
    // layout needed to overflow without turning this visual contract into a rate-limit test.
    const longSpaceName = `A Space With An Exceptionally Long Accessible Name ${runId}`;
    for (let index = 0; index < 4; index++) {
      await joinedFixture(members[index % members.length], {
        name: index === 0 ? longSpaceName : `Shell space ${index} ${runId}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
    }

    for (let index = 0; index < 3; index++) {
      await joinedFixture(members[index % members.length], {
        name: `Shell filler room ${index} ${runId}`,
        preset: 'private_chat',
      });
    }

    // A separate unread target per density means each long row still carries its badge
    // before that density's journey opens and marks it read.
    const roomNames = {
      cosy: `Cosy Room Name ${runId} That Is Deliberately Much Wider Than The Sidebar`,
      compact: `Compact Room Name ${runId} That Is Deliberately Much Wider Than The Sidebar`,
    } as const;
    for (const [densityIndex, density] of (
      ['cosy', 'compact'] as const
    ).entries()) {
      const owner = members[densityIndex];
      const roomId = await createRoom(request, hs, owner, {
        name: roomNames[density],
        preset: 'private_chat',
        invite: [
          reader.userId,
          ...members
            .filter((member) => member !== owner)
            .map((member) => member.userId),
        ],
      });
      await joinRoom(request, hs, reader, roomId);
      for (const member of members) {
        if (member !== owner) await joinRoom(request, hs, member, roomId);
      }
      await sendMessages(request, hs, owner, roomId, `${density}-${runId}`);
    }

    await login(page, {
      available: true,
      hs,
      user: readerName,
      pass: readerPass,
    } as SynapseSession);

    for (const density of ['cosy', 'compact'] as const) {
      await seedPreference(page, DENSITY_KEY, density);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-shell-root]')).toBeVisible({
        timeout: 30_000,
      });
      if (density === 'compact') {
        await expect(page.locator('html')).toHaveAttribute(
          'data-density',
          'compact',
        );
      } else {
        await expect(page.locator('html')).not.toHaveAttribute('data-density');
      }

      await page.getByTestId('rail-rooms').click();
      const row = page.locator('.channel-row', {
        has: page.locator('.channel', { hasText: roomNames[density] }),
      });
      await row.first().waitFor({ state: 'visible', timeout: 30_000 });
      await row.first().scrollIntoViewIfNeeded();

      await expectEllipsis(row.locator('.channel__name'));
      await expect(row.locator('.channel__badge')).toBeVisible();
      await expectInside(row.locator('.channel__badge'), row);
      await expectInside(row.locator('.channel__menu'), row);
      await expectEllipsis(page.locator('.userbar__name'));
      await expectInside(
        page.getByTestId('open-settings'),
        page.locator('.userbar'),
      );

      // Rail labels remain fully accessible while the fixed pill stays inside its pane.
      const accessibleSpacePill = page.getByRole('button', {
        name: longSpaceName,
        exact: true,
      });
      await expect(accessibleSpacePill).toBeAttached();
      await accessibleSpacePill.scrollIntoViewIfNeeded();
      await expectInside(accessibleSpacePill, page.locator('.rail'));

      await row.locator('.channel').click();
      await expect(page.locator('.scroll')).toBeVisible({ timeout: 30_000 });
      if (
        !(await page
          .locator('.members')
          .isVisible()
          .catch(() => false))
      ) {
        await page.getByTestId('toggle-members').click();
      }
      await expect(page.locator('.members')).toBeVisible({ timeout: 20_000 });
      await expectEllipsis(
        page.locator('.member__name', { hasText: 'Morgan With A Member Name' }),
      );
      for (const viewport of [
        { width: 1280, height: 720 },
        { width: 1024, height: 768 },
        { width: 900, height: 700 },
      ]) {
        await expectScrollContract(page, viewport);
      }
    }
  });
});
