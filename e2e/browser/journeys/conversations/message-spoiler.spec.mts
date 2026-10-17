import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  seedFormattedRoom,
  sendMessage,
  signInAndOpen,
} from '../../support/formatted-message-journey.mts';
import { openNamedRoom as openRoom } from '../../../support/message-composer.mts';

// End-to-end for spoiler reveal: a message carrying a `data-mx-spoiler` span renders
// concealed, and clicking it uncovers it. The spoiler is injected through the Matrix
// API (send-side spoiler syntax is a separate follow-up). Needs Synapse (Docker).
const session = homeserverSession();

/** Register a user, create their room, and drop a spoiler message straight in. */
async function seedRoomWithSpoiler(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{ user: HomeserverSession; roomName: string; secret: string }> {
  const username = `spoiler-user-${runId}`;
  const password = `${username}-pass`;
  const roomName = `Spoiler E2E ${runId}`;
  const secret = `answer-${runId}`;

  await registerUser(request, username, password);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      },
    })
    .then((r) => r.json());
  const headers = { Authorization: `Bearer ${access_token}` };

  const roomId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);

  await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/spoiler-${runId}`,
    {
      headers,
      data: {
        msgtype: 'm.text',
        body: `the secret is ${secret}`,
        format: 'org.matrix.custom.html',
        formatted_body: `the secret is <span data-mx-spoiler>${secret}</span>`,
      },
    },
  );

  return {
    user: { available: true, hs, user: username, pass: password },
    roomName,
    secret,
  };
}

test.describe('Spoiler reveal', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('conceals a spoiler and reveals it on click', async ({
    page,
    request,
  }) => {
    const runId = `${testResourceId('run')}s`;
    const { user, roomName } = await seedRoomWithSpoiler(
      request,
      session.hs as string,
      runId,
    );

    await login(page, user);
    await openRoom(page, roomName);

    // The spoiler renders as an mx-spoiler span (data-mx-spoiler doesn't survive the
    // render-leaf sanitizer), concealed until activated.
    const spoiler = page.locator('.scroll .mx-spoiler').first();
    await expect(spoiler).toBeVisible({ timeout: 20_000 });
    await expect(spoiler).not.toHaveClass(/is-revealed/);
    // Concealed text is painted transparent (the black-bar effect).
    await expect(spoiler).toHaveCSS('color', 'rgba(0, 0, 0, 0)');

    await spoiler.click();

    await expect(spoiler).toHaveClass(/is-revealed/);
    await expect(spoiler).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  });
});

test.describe('Spoiler reasons', () => {
  test.skip(!session.available, 'needs a homeserver');

  test('shows the sender’s reason on the concealed bar and announces it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'spoiler-reason');
    await sendMessage(request, hs, room, {
      body: 'the twist',
      html: 'the twist: <span data-mx-spoiler="ending of the film">she lives</span>',
    });
    await signInAndOpen(page, room);

    const spoiler = page.locator('.scroll .mx-spoiler').first();
    await expect(spoiler).toHaveAttribute('label', 'ending of the film', {
      timeout: 20_000,
    });
    await expect(spoiler).toHaveAttribute(
      'aria-label',
      'Spoiler: ending of the film, activate to reveal',
    );
    const before = () =>
      spoiler.evaluate(
        (element) => getComputedStyle(element, '::before').content,
      );
    expect(await before()).toContain('Spoiler: ');
    await expect(spoiler).toHaveCSS('color', 'rgba(0, 0, 0, 0)');

    await spoiler.click();

    await expect(spoiler).toHaveClass(/is-revealed/);
    await expect(spoiler).not.toHaveAttribute('aria-label');
    expect(await before()).toBe('none');
  });

  // High Contrast forces system colours, which would print the hidden text over the bar's
  // fill; the stylesheet keeps the bar solid and the reason readable on it.
  test('keeps a concealed spoiler a solid bar with a readable reason in forced colours', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const room = await seedFormattedRoom(request, hs, 'spoiler-forced');
    await sendMessage(request, hs, room, {
      body: 'the twist',
      html: 'the twist: <span data-mx-spoiler="ending of the film">she lives</span>',
    });
    await page.emulateMedia({ forcedColors: 'active' });
    await signInAndOpen(page, room);

    const spoiler = page.locator('.scroll .mx-spoiler').first();
    await expect(spoiler).toHaveAttribute('label', 'ending of the film', {
      timeout: 20_000,
    });
    const colours = () =>
      spoiler.evaluate((element) => {
        const bar = getComputedStyle(element);
        const reason = getComputedStyle(element, '::before');
        return {
          text: bar.color,
          fill: bar.backgroundColor,
          reason: reason.color,
          content: reason.content,
        };
      });

    await expect
      .poll(
        async () => {
          const { text, fill } = await colours();
          return text === fill && fill !== 'rgba(0, 0, 0, 0)';
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const { fill, reason, content } = await colours();
    expect(reason).not.toBe(fill);
    expect(content).toContain('Spoiler: ');
  });
});
