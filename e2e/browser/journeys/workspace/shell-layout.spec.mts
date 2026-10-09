import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  seedPreference,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';

/**
 * Rendered Phase 2 shell contract.
 *
 * Source guards pin the recipes, but only a browser can prove that overflowing real Matrix
 * content has one scroll owner per pane and that long labels do not push badges/actions out
 * of their columns. This deliberately seeds all four vertical panes and repeats the layout in
 * Cosy and Compact at the three phase-closing desktop viewports.
 */
const session = homeserverSession();
const DENSITY_KEY = 'trinity.appearance.density';

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
  mention?: string,
): Promise<void> {
  for (let index = 0; index < 42; index++) {
    const response = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${prefix}-${index}`,
      {
        headers: actor.headers,
        data: {
          msgtype: 'm.text',
          body: `${prefix} message ${index} with enough text to occupy the timeline`,
          // The last message mentions the reader, so the row carries its danger badge.
          ...(mention && index === 41
            ? { 'm.mentions': { user_ids: [mention] } }
            : {}),
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

async function expectFloatingDockContract(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.shell-side');
    const rail = document.querySelector<HTMLElement>('.rail');
    const railScroller = document.querySelector<HTMLElement>('.rail-scroll');
    const sidebar = document.querySelector<HTMLElement>('.sidebar');
    const roomScroller =
      document.querySelector<HTMLElement>('.sidebar__scroll');
    const host = document.querySelector<HTMLElement>('trn-sidebar-user-panel');
    const dock = document.querySelector<HTMLElement>('.userbar');
    const settingsButton = document.querySelector<HTMLElement>(
      '[data-testid="open-settings"]',
    );
    const settingsIcon = settingsButton?.querySelector<HTMLElement>('trn-icon');
    const lastSpace = railScroller?.lastElementChild as HTMLElement | null;
    const lastRoom = roomScroller?.lastElementChild as HTMLElement | null;
    if (
      !shell ||
      !rail ||
      !railScroller ||
      !sidebar ||
      !roomScroller ||
      !host ||
      !dock ||
      !settingsButton ||
      !settingsIcon ||
      !lastSpace ||
      !lastRoom
    ) {
      throw new Error('missing floating identity dock geometry');
    }

    shell.style.setProperty('--trinity-navigation-safe-area-bottom', '24px');
    railScroller.scrollTop = railScroller.scrollHeight;
    roomScroller.scrollTop = roomScroller.scrollHeight;
    const shellBox = shell.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const sidebarBox = sidebar.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const settingsButtonBox = settingsButton.getBoundingClientRect();
    const settingsIconBox = settingsIcon.getBoundingClientRect();
    const spaceBox = lastSpace.getBoundingClientRect();
    const roomBox = lastRoom.getBoundingClientRect();
    const railStyle = getComputedStyle(railScroller);
    const roomStyle = getComputedStyle(roomScroller);
    const result = {
      density: document.documentElement.dataset['density'] ?? 'cosy',
      hostPosition: getComputedStyle(host).position,
      railScrollPaddingEnd: Number.parseFloat(railStyle.scrollPaddingBlockEnd),
      roomScrollPaddingEnd: Number.parseFloat(roomStyle.scrollPaddingBlockEnd),
      dockInsideInline:
        dockBox.left >= shellBox.left - 1 &&
        dockBox.right <= shellBox.right + 1,
      dockInsideBlock:
        dockBox.top >= shellBox.top - 1 &&
        dockBox.bottom <= shellBox.bottom + 1,
      clearsSafeArea: dockBox.bottom <= shellBox.bottom - 24,
      spansRailAndRooms:
        dockBox.left < railBox.right && dockBox.right > sidebarBox.left,
      lastSpaceClearsDock: spaceBox.bottom <= dockBox.top - 1,
      lastRoomClearsDock: roomBox.bottom <= dockBox.top - 1,
      settingsIconOffsetX: Math.abs(
        settingsButtonBox.left +
          settingsButtonBox.width / 2 -
          (settingsIconBox.left + settingsIconBox.width / 2),
      ),
      settingsIconOffsetY: Math.abs(
        settingsButtonBox.top +
          settingsButtonBox.height / 2 -
          (settingsIconBox.top + settingsIconBox.height / 2),
      ),
    };
    shell.style.removeProperty('--trinity-navigation-safe-area-bottom');
    return result;
  });

  // Dock clearance is the 60px --trinity-navigation-dock-height plus the density's
  // --trinity-space-5 gap (cosy 16, compact 12, spacious 20).
  const dockClearance =
    { cosy: 60 + 16, compact: 60 + 12, spacious: 60 + 20 }[geometry.density] ??
    Number.NaN;
  expect(geometry.railScrollPaddingEnd).toBe(dockClearance);
  expect(geometry.roomScrollPaddingEnd).toBe(dockClearance);
  expect(geometry.settingsIconOffsetX).toBeLessThanOrEqual(1);
  expect(geometry.settingsIconOffsetY).toBeLessThanOrEqual(1);
  expect(geometry).toMatchObject({
    hostPosition: 'absolute',
    dockInsideInline: true,
    dockInsideBlock: true,
    clearsSafeArea: true,
    spansRailAndRooms: true,
    lastSpaceClearsDock: true,
    lastRoomClearsDock: true,
  });

  for (const [testId, scrollerSelector] of [
    ['dock-focus-space', '.rail-scroll'],
    ['dock-focus-room', '.sidebar__scroll'],
  ] as const) {
    const beforeFocus = await page.evaluate(
      ({ id, selector }) => {
        const row = document.querySelector<HTMLElement>(
          `[data-testid="${id}"]`,
        );
        const dock = document.querySelector<HTMLElement>('.userbar');
        const scroller = document.querySelector<HTMLElement>(selector);
        if (!row || !dock || !scroller) {
          throw new Error(`missing ${id} pre-focus geometry`);
        }
        scroller.scrollTop = 0;
        return {
          scrollTop: scroller.scrollTop,
          needsScroll:
            row.getBoundingClientRect().bottom >
            dock.getBoundingClientRect().top,
        };
      },
      { id: testId, selector: scrollerSelector },
    );
    expect(beforeFocus).toEqual({ scrollTop: 0, needsScroll: true });

    await page.getByTestId(testId).locator('button').first().focus();
    await expect
      .poll(() =>
        page.evaluate(
          ({ id, selector }) => {
            const row = document.querySelector<HTMLElement>(
              `[data-testid="${id}"]`,
            );
            const dock = document.querySelector<HTMLElement>('.userbar');
            const scroller = document.querySelector<HTMLElement>(selector);
            if (!row || !dock || !scroller) {
              throw new Error(`missing ${id} focus geometry`);
            }
            return (
              scroller.scrollTop > 0 &&
              document.activeElement === row.querySelector('button') &&
              row.getBoundingClientRect().bottom <=
                dock.getBoundingClientRect().top - 1
            );
          },
          { id: testId, selector: scrollerSelector },
        ),
      )
      .toBe(true);
  }
}

async function expectAccountMenuAboveDock(page: Page): Promise<void> {
  const membersBackdrop = page.getByTestId('members-backdrop');
  if (await membersBackdrop.isVisible()) {
    await membersBackdrop.click({ position: { x: 8, y: 8 } });
    await expect(membersBackdrop).toBeHidden();
  }

  const trigger = page.getByTestId('user-menu-trigger');
  await trigger.click();
  const menu = page.getByRole('menu').last();
  await expect(menu).toBeVisible();

  // The seeded reader has a deliberately long display name. Check the real account row
  // keeps both identity lines accessible while its fixed-width text column clips safely.
  const accountRow = menu.getByTestId('account-row').first();
  await expect(accountRow).toBeVisible();
  await expect(accountRow.locator('.account-row__name')).toContainText(
    'Alexandria Very Long Account Name',
  );
  await expectEllipsis(accountRow.locator('.account-row__name'));
  await expectEllipsis(accountRow.locator('.account-row__handle'));
  const activeCheck = accountRow.locator('.account-row__check');
  if (await activeCheck.count()) {
    await expectInside(activeCheck, accountRow);
  }
  const unreadBadge = accountRow.locator('.account-row__badge');
  if (await unreadBadge.count()) {
    await expectInside(unreadBadge, accountRow);
  }

  // The floating panel is a padded surface around its controls, so the anchored overlay may
  // sit over that padding and shadow. It must stay above the controls themselves (the
  // identity trigger, and the "+N" chip when present) after its entrance motion settles.
  await expect
    .poll(async () => {
      const [menuBox, triggerBox] = await Promise.all([
        menu.boundingBox(),
        trigger.boundingBox(),
      ]);
      return Boolean(
        menuBox && triggerBox && menuBox.y + menuBox.height <= triggerBox.y,
      );
    })
    .toBe(true);

  // Capture reviewable visual proof for both themes at the larger text scale. The state is
  // restored immediately so this helper remains safe inside the cosy/compact loop.
  const appearance = await page.evaluate(() => ({
    dark: document.documentElement.classList.contains('dark'),
    fontSize: document.documentElement.style.fontSize,
  }));
  for (const dark of [false, true]) {
    await page.evaluate((selectedDark) => {
      document.documentElement.classList.toggle('dark', selectedDark);
      document.documentElement.style.fontSize = '125%';
    }, dark);
    await expect(menu).toBeVisible();
    const viewport = page.viewportSize();
    const menuBox = await menu.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.x).toBeGreaterThanOrEqual(-1);
    expect(menuBox!.y).toBeGreaterThanOrEqual(-1);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(
      (viewport?.width ?? 0) + 1,
    );
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(
      (viewport?.height ?? 0) + 1,
    );
    await test
      .info()
      .attach(
        `account-menu-${dark ? 'dark' : 'light'}-${viewport?.width ?? 'unknown'}-${viewport?.height ?? 'unknown'}`,
        {
          body: await page.screenshot(),
          contentType: 'image/png',
        },
      );
  }
  await page.evaluate(({ dark, fontSize }) => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.fontSize = fontSize;
  }, appearance);

  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
}

async function expectScrollContract(
  page: Page,
  viewport: { width: number; height: number },
  activate: (target: Locator) => Promise<void>,
): Promise<void> {
  const previousViewport = page.viewportSize();
  await page.setViewportSize(viewport);
  const membersToggle = page.getByTestId('toggle-members');
  const memberList = page.getByTestId('member-list');
  if (
    previousViewport !== null &&
    previousViewport.width >= 1100 &&
    viewport.width < 1100
  ) {
    // Entering the drawer presentation deliberately closes the remembered wide roster.
    await expect(membersToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(memberList).toBeHidden();
    await activate(membersToggle);
  }
  await expect(membersToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(memberList).toBeVisible();
  await expect(memberList.locator('.member').first()).toBeVisible();

  // The responsive surface may be recreated on resize. Reopen it and wait for its real
  // rows before adding inert overflow copies to exercise the scroll geometry.
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
    const selectors = [
      '.rail-scroll',
      '.sidebar__scroll',
      '.scroll',
      '.members',
    ];
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
    ['.rail-scroll', '.sidebar__scroll', '.scroll', '.members'].map(
      (selector) => ({
        selector,
        overflowY: 'auto',
        overflows: true,
      }),
    ),
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
  // The roster is a fixed 240px column (border included) however long a member name is.
  await expect(page.locator('.chat-members')).toHaveCSS('width', '240px');
  await expectFloatingDockContract(page);
}

/**
 * Repeat already-rendered navigation rows until their real scrollers overflow. The source
 * room/space/member/message data remains Matrix-backed; the inert copies avoid dozens of
 * unrelated join-rate-limit waits while exercising the same browser boxes and scroll CSS.
 */
async function fillNavigationScrollers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fill = (
      rootSelector: string,
      sourceSelector: string,
      focusTestId?: string,
    ) => {
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
      if (focusTestId) {
        root
          .querySelector(`[data-testid="${focusTestId}"]`)
          ?.removeAttribute('data-testid');
        const last = root.lastElementChild as HTMLElement | null;
        last?.removeAttribute('aria-hidden');
        last?.removeAttribute('inert');
        last?.setAttribute('data-testid', focusTestId);
      }
    };
    fill('.rail-scroll', '.rail-scroll .item', 'dock-focus-space');
    fill(
      '.sidebar__scroll',
      '.sidebar__scroll .channel-row',
      'dock-focus-room',
    );
    fill('.members', '.members .member');
  });
}

test.describe('Modern room shell layout', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('keeps overflowing panes and long identities safe in every density', async ({
    page,
    request,
  }) => {
    const activate = (target: Locator): Promise<void> => target.click();
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}sh`;
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
      spacious: `Spacious Room Name ${runId} That Is Deliberately Much Wider Than The Sidebar`,
    } as const;
    const shellSpacing = {
      cosy: { gap: '8px', padding: '8px' },
      compact: { gap: '4px', padding: '6px' },
      spacious: { gap: '10px', padding: '14px' },
    } as const;
    for (const [densityIndex, density] of (
      ['cosy', 'compact', 'spacious'] as const
    ).entries()) {
      const owner = members[densityIndex];
      const roomId = await createRoom(request, hs, owner, {
        name: roomNames[density],
        topic: `Topic ${runId} ${'a very long topic '.repeat(20)}`.slice(
          0,
          300,
        ),
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
      await sendMessages(
        request,
        hs,
        owner,
        roomId,
        `${density}-${runId}`,
        reader.userId,
      );
    }

    await login(page, {
      available: true,
      hs,
      user: readerName,
      pass: readerPass,
    } as HomeserverSession);

    for (const density of ['cosy', 'compact', 'spacious'] as const) {
      await seedPreference(page, DENSITY_KEY, density);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-shell-root]')).toBeVisible({
        timeout: 30_000,
      });
      if (density !== 'cosy') {
        await expect(page.locator('html')).toHaveAttribute(
          'data-density',
          density,
        );
      } else {
        await expect(page.locator('html')).not.toHaveAttribute('data-density');
      }

      const { gap: shellGap, padding: shellPadding } = shellSpacing[density];
      // Pinned and scrolling rail groups both space their items by the density gap.
      await expect(page.locator('.rail-fixed')).toHaveCSS('gap', shellGap);
      await expect(page.locator('.rail-scroll')).toHaveCSS('gap', shellGap);
      await expect(page.locator('.sidebar__header')).toHaveCSS(
        'padding-left',
        shellPadding,
      );

      await page.getByTestId('rail-rooms').click();
      const row = page.locator('.channel-row', {
        has: page.locator('.channel', { hasText: roomNames[density] }),
      });
      await row.first().waitFor({ state: 'visible', timeout: 30_000 });
      await row.first().scrollIntoViewIfNeeded();

      await expectEllipsis(row.locator('.channel__name'));
      await expect(row.locator('.channel--unread')).toBeVisible();
      await expect(row.locator('[data-slot="badge"]')).toBeVisible();
      await expectInside(row.locator('[data-slot="badge"]'), row);
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
      await expectInside(accessibleSpacePill, page.locator('.rail-scroll'));

      await row.locator('.channel').click();
      await expect(page.locator('.scroll')).toBeVisible({ timeout: 30_000 });
      if (
        (await page
          .getByTestId('toggle-members')
          .getAttribute('aria-pressed')) !== 'true'
      ) {
        await activate(page.getByTestId('toggle-members'));
      }
      await expect(page.locator('.members')).toBeVisible({ timeout: 20_000 });

      // A long room name and a 300-character topic truncate inside the 48px header: the
      // header never overflows horizontally and its actions stay reachable.
      const headerViewport = page.viewportSize()!;
      await page.setViewportSize({ width: 1100, height: 800 });
      const header = page.locator('header[data-trn-layout="toolbar"]');
      await expect(page.getByTestId('room-topic')).toBeVisible();
      await expect(header).toHaveCSS('height', '48px');
      expect(
        await header.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await expect(page.getByTestId('header-search')).toBeVisible();
      await expect(page.getByTestId('room-actions-overflow')).toBeVisible();
      await page.setViewportSize(headerViewport);
      // Crossing the drawer breakpoint closes the roster from an effect that can land after
      // the resize resolves, so a single aria-pressed read can see it still open. Retry the
      // read-and-reopen until the roster is actually on screen.
      const toggleMembers = page.getByTestId('toggle-members');
      await expect(async () => {
        if ((await toggleMembers.getAttribute('aria-pressed')) !== 'true') {
          await activate(toggleMembers);
        }
        await expect(page.locator('.members')).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });

      await expect(page.locator('.member').first()).toHaveCSS('height', '44px');
      await expect(page.locator('.member').first()).toHaveCSS(
        'padding-left',
        shellPadding,
      );
      await expect(page.locator('.members__section-label').first()).toHaveCSS(
        'height',
        '34px',
      );
      await expectEllipsis(
        page.locator('.member__name', { hasText: 'Morgan With A Member Name' }),
      );
      for (const viewport of [
        { width: 1280, height: 720 },
        { width: 1024, height: 768 },
        { width: 900, height: 700 },
      ]) {
        await expectScrollContract(page, viewport, activate);
      }

      await expectAccountMenuAboveDock(page);

      if (density === 'compact') {
        await page.evaluate(() => {
          document.documentElement.dir = 'rtl';
        });
        await expectFloatingDockContract(page);
        await page.evaluate(() => {
          document.documentElement.removeAttribute('dir');
        });
      }
    }
  });

  test('keeps the topic popover closed until asked and marks the pressed header button', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${testResourceId('run')}hp`;
    const user = `header-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Header popover ${runId}`;
    const reader = await account(request, hs, user, pass);
    await createRoom(request, hs, reader, {
      name: roomName,
      topic: `Release planning ${runId}`,
      preset: 'private_chat',
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, {
      available: true,
      hs,
      user,
      pass,
    } as HomeserverSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();
    await expect(page.getByTestId('composer-input')).toBeVisible({
      timeout: 15_000,
    });

    // Beside static panels the header carries the inline search field, not the icon.
    await expect(page.getByTestId('header-search')).toBeVisible();
    await expect(page.getByTestId('search-messages')).toBeHidden();

    // The pressed panel button shows the selected surface and the bright text colour.
    const pinned = page.getByTestId('open-pinned');
    await pinned.click();
    await expect(pinned).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('pinned-close')).toBeVisible();

    // The room-list and conversation headers share one 48px band: their bottom edges line
    // up at 1280x800. The side panel sits in the row under the conversation header (its
    // buttons drive it), so its 48px header starts where that band ends.
    const conversationHeader = await page
      .locator('header[data-trn-layout="toolbar"]')
      .boundingBox();
    const sidebarHeader = await page.locator('.sidebar__header').boundingBox();
    const panelHeader = await page
      .locator('trn-side-panel-header')
      .boundingBox();
    const bottom = (box: { y: number; height: number } | null) =>
      Math.round(box!.y + box!.height);
    expect(conversationHeader!.height).toBe(48);
    expect(sidebarHeader!.height).toBe(48);
    expect(bottom(sidebarHeader)).toBe(bottom(conversationHeader));
    expect(Math.round(panelHeader!.height)).toBe(48);
    expect(Math.round(panelHeader!.y)).toBe(bottom(conversationHeader));
    // Off the button, and polled: the ghost recipe transitions its background.
    await page.mouse.move(0, 0);
    await expect
      .poll(() =>
        pinned.evaluate((button) => {
          const probe = document.createElement('div');
          probe.style.background = 'var(--trinity-state-selected-surface)';
          probe.style.color = 'var(--trinity-text-bright)';
          document.body.append(probe);
          const want = getComputedStyle(probe);
          const got = getComputedStyle(button);
          const same =
            got.backgroundColor === want.backgroundColor &&
            got.color === want.color;
          probe.remove();
          return same;
        }),
      )
      .toBe(true);

    // The closed topic popover is not rendered; the topic opens it and Escape closes
    // only the popover, leaving the open panel in place.
    const popover = page.locator('#room-topic-popover');
    await expect(popover).toBeHidden();
    await page.getByTestId('room-topic').click();
    await expect(popover).toBeVisible();
    await expect(popover).toContainText(`Release planning ${runId}`);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(page.getByTestId('pinned-close')).toBeVisible();

    // Below the members breakpoint panels are drawers over the header, so the icon
    // replaces the inline field.
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.getByTestId('header-search')).toBeHidden();
    await expect(page.getByTestId('search-messages')).toBeVisible();
  });
});
