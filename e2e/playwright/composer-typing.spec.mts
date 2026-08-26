import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// End-to-end for typing indicators: when another member of the open room starts
// typing, the app shows an "X is typing" row under the timeline, and clears it once
// they stop. The other member's typing is driven straight through the Matrix API, so
// this exercises our sync → signal → render path. Needs a Synapse homeserver (Docker).
const session = synapseSession();

async function apiToken(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<{ userId: string; headers: { Authorization: string } }> {
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

/** Register a reader plus a named member who joins the reader's room. */
async function seedRoomWithMember(
  request: APIRequestContext,
  hs: string,
  runId: string,
  displayName?: string,
): Promise<{
  reader: SynapseSession;
  roomName: string;
  roomId: string;
  memberName: string;
  memberId: string;
  memberHeaders: { Authorization: string };
}> {
  const readerUser = `typing-reader-${runId}`;
  const readerPass = `${readerUser}-pass`;
  const memberUser = `typing-member-${runId}`;
  const memberPass = `${memberUser}-pass`;
  const memberName = displayName ?? `Tilly${runId}`;
  const roomName = `Typing E2E ${runId}`;

  await registerUser(request, readerUser, readerPass);
  await registerUser(request, memberUser, memberPass);
  const reader = await apiToken(request, hs, readerUser, readerPass);
  const member = await apiToken(request, hs, memberUser, memberPass);

  // A deterministic display name so the typing row is easy to assert on.
  await request.put(
    `${hs}/_matrix/client/v3/profile/${encodeURIComponent(member.userId)}/displayname`,
    { headers: member.headers, data: { displayname: memberName } },
  );

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: reader.headers,
      data: { name: roomName, invite: [member.userId] },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  await request.post(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { headers: member.headers },
  );

  return {
    reader: { available: true, hs, user: readerUser, pass: readerPass },
    roomName,
    roomId,
    memberName,
    memberId: member.userId,
    memberHeaders: member.headers,
  };
}

/** Drive the other member's typing state straight through the Matrix API. */
async function setMemberTyping(
  request: APIRequestContext,
  hs: string,
  roomId: string,
  member: { userId: string; headers: { Authorization: string } },
  typing: boolean,
): Promise<void> {
  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(member.userId)}`,
    {
      headers: member.headers,
      data: typing ? { typing: true, timeout: 30_000 } : { typing: false },
    },
  );
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

test.describe('Typing indicators', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test("shows and clears another member's typing", async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}t`;
    const hs = session.hs as string;
    const { reader, roomName, roomId, memberName, memberId, memberHeaders } =
      await seedRoomWithMember(request, hs, runId);
    const member = { userId: memberId, headers: memberHeaders };

    await login(page, reader);
    await openRoom(page, roomName);

    const indicator = page.getByTestId('typing-indicator');

    // The other member starts typing → the row appears naming them.
    await setMemberTyping(request, hs, roomId, member, true);
    await expect(indicator).toBeVisible({ timeout: 20_000 });
    // Exact match, and the dots are empty spans, so they contribute no text. Keep this
    // after the `toBeVisible` above and never split the two: `toBeHidden` below passes
    // for a DETACHED node, so on its own it would also pass for a renamed testid.
    await expect(indicator).toHaveText(`${memberName} is typing`);

    // …and stops → the row goes away.
    await setMemberTyping(request, hs, roomId, member, false);
    await expect(indicator).toBeHidden({ timeout: 20_000 });
  });

  // The reserved slot is the reason the timeline stops shifting, and it is invisible to
  // every unit test in the tree: jsdom applies no CSS, so the slot has no height there.
  test('reserves the typing row space whether or not anyone is typing', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}r`;
    const hs = session.hs as string;
    const { reader, roomName, roomId, memberId, memberHeaders } =
      await seedRoomWithMember(request, hs, runId);
    const member = { userId: memberId, headers: memberHeaders };

    await login(page, reader);
    await openRoom(page, roomName);

    const slot = page.locator('.typing-slot');
    const heightOf = (locator: Locator): Promise<number> =>
      locator.evaluate((element) => element.getBoundingClientRect().height);

    // Reserved while idle. Without this the comparison below is unfalsifiable — a slot
    // that is 0px both times is "unchanged" and proves nothing.
    const idleSlot = await heightOf(slot);
    expect(idleSlot).toBeGreaterThan(0);

    await setMemberTyping(request, hs, roomId, member, true);
    // Wait for the row, not for the PUT: it resolves when the server accepts it, long
    // before the EDU comes back down /sync. Measuring straight after would read the
    // pre-state and pass whatever the CSS said.
    await expect(page.getByTestId('typing-indicator')).toBeVisible({
      timeout: 20_000,
    });

    // Sub-pixel tolerance, not equality: the reserved box lays out at 25.1875 and the
    // occupied line box at 25.203125, a 0.016px LayoutNG difference. The regression this
    // guards is 6px — `min-height: 1.2rem` without this rule's own padding, which
    // `box-sizing: border-box` folds in — so a 1px bound catches it with room to spare.
    //
    // The slot's own height, and NOT `.scroll`'s clientHeight. The scroller is what the
    // reader sees move, but it is confounded: the "Set up encryption" banner can mount
    // between the two reads and shift it 44px on its own, which is a flake rather than a
    // finding. If the slot never changes height, typing cannot resize the scroller.
    expect(Math.abs((await heightOf(slot)) - idleSlot)).toBeLessThan(1);
  });

  // The case the assertion above cannot reach: `min-height` is a floor, so a sentence long
  // enough to wrap grows the slot regardless. Measured before the clamp, two ordinary
  // display names at a phone width took the row from 25.19px to 44.41px — the very jump
  // this component exists to remove. A narrow viewport and a long name reproduce it in one
  // test rather than needing two typists.
  test('holds one line when the name is too long for the row', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const runId = `${Date.now().toString(36)}w`;
    const hs = session.hs as string;
    const { reader, roomName, roomId, memberId, memberHeaders } =
      await seedRoomWithMember(
        request,
        hs,
        runId,
        'Alexandra Wellington-Fitzgerald the Third of Northumberland and Wessex',
      );
    const member = { userId: memberId, headers: memberHeaders };

    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, reader);
    await openRoom(page, roomName);

    const slot = page.locator('.typing-slot');
    const idle = await slot.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
    expect(idle).toBeGreaterThan(0);

    await setMemberTyping(request, hs, roomId, member, true);
    await expect(page.getByTestId('typing-indicator')).toBeVisible({
      timeout: 20_000,
    });

    expect(
      Math.abs(
        (await slot.evaluate(
          (element) => element.getBoundingClientRect().height,
        )) - idle,
      ),
    ).toBeLessThan(1);

    // And the name is ellipsised rather than clipped mid-word or overflowing the row.
    const text = page.locator('.typing-indicator__text');
    const overflows = await text.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(overflows).toBe(true);
  });

  test('the dots are actually animating', async ({ page, request }) => {
    const runId = `${Date.now().toString(36)}a`;
    const hs = session.hs as string;
    const { reader, roomName, roomId, memberId, memberHeaders } =
      await seedRoomWithMember(request, hs, runId);
    const member = { userId: memberId, headers: memberHeaders };

    await login(page, reader);
    await openRoom(page, roomName);

    await setMemberTyping(request, hs, roomId, member, true);
    await expect(page.getByTestId('typing-indicator')).toBeVisible({
      timeout: 20_000,
    });

    // getAnimations(), not `getComputedStyle().animationName`: that returns the declared
    // identifier whether or not any @keyframes rule matches it, so deleting the keyframes
    // block would leave a name assertion green with three frozen dots on screen.
    const running = await page
      .locator('.typing-dots__dot')
      .first()
      .evaluate((element) =>
        element.getAnimations().map((animation) => ({
          duration: animation.effect?.getComputedTiming().duration ?? null,
          iterations: animation.effect?.getComputedTiming().iterations ?? null,
        })),
      );

    expect(running).toHaveLength(1);
    // --trinity-duration-pulse, resolved.
    expect(running[0].duration).toBe(1000);
    expect(running[0].iterations).toBe(Infinity);
  });

  test('reduced motion rests the dots at full opacity', async ({
    page,
    request,
  }) => {
    const runId = `${Date.now().toString(36)}m`;
    const hs = session.hs as string;
    const { reader, roomName, roomId, memberId, memberHeaders } =
      await seedRoomWithMember(request, hs, runId);
    const member = { userId: memberId, headers: memberHeaders };

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, reader);
    await openRoom(page, roomName);

    await setMemberTyping(request, hs, roomId, member, true);
    await expect(page.getByTestId('typing-indicator')).toBeVisible({
      timeout: 20_000,
    });

    // Collapsing --trinity-duration-pulse does NOT stop an infinite animation; the blanket
    // `animation-iteration-count: 1` in global.scss does, and the dots then fall back to
    // their BASE style, because the `animation` shorthand sets `animation-fill-mode: none`.
    //
    // So this catches `animation-fill-mode: forwards`, or a base `opacity` below 1 — the
    // two ways a reduced-motion user ends up on permanently dimmed dots. It does NOT catch
    // an inverted keyframe: with fill-mode `none` the frames stop contributing once the
    // animation is over, so the resting value is 1 either way.
    const opacities = await page
      .locator('.typing-dots__dot')
      .evaluateAll((elements) =>
        elements.map((element) => getComputedStyle(element).opacity),
      );

    expect(opacities).toEqual(['1', '1', '1']);
  });

  test('shows the typist in the room list, but never yourself', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const runId = `${Date.now().toString(36)}s`;
    const hs = session.hs as string;
    const { reader, roomName, roomId, memberName, memberId, memberHeaders } =
      await seedRoomWithMember(request, hs, runId);
    const member = { userId: memberId, headers: memberHeaders };

    await login(page, reader);
    await openRoom(page, roomName);

    const channel = page.locator('.channel', { hasText: roomName }).first();
    const typingPreview = channel.locator('.channel__preview--typing');

    // Someone else types → the room's line says so.
    await setMemberTyping(request, hs, roomId, member, true);
    await expect(typingPreview).toHaveText(`${memberName} is typing`, {
      timeout: 20_000,
    });

    await setMemberTyping(request, hs, roomId, member, false);
    await expect(typingPreview).toHaveCount(0, { timeout: 20_000 });

    // Now type yourself. The local user is excluded, so the line must NOT swap — the
    // failure this guards reads "You are typing" on every room you type in.
    await page.getByTestId('composer-input').fill('writing something');
    // Long enough for the EDU to round-trip if it were going to: the indicator above
    // appeared well inside this budget.
    await expect(page.getByTestId('typing-indicator')).toHaveCount(0);
    await expect(typingPreview).toHaveCount(0);
  });
});
