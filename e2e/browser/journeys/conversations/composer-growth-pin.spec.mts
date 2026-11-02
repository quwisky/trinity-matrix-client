import {
  expect,
  test,
  testResourceId,
  type Locator,
} from '../../../fixtures.mts';
import { homeserverSession, login } from '../../../support/app.mts';
import { apiLogin, registerUser } from '../../../support/account.mts';
import { DESIGN_VIEWPORTS } from '../../support/design-viewports.mts';
import { createRoom } from '../../support/space-journey.mts';

// Measuring a growing composer must not move the timeline: jsdom cannot show the browser
// clamping scrollTop during the measurement's forced layout, so this needs real layout.
const session = homeserverSession();
const BURST = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do ';
const BURSTS = 8;

/** Where the scroller and field are after the pin's frame has run. */
const settled = (field: Locator) =>
  field.evaluate(async (input) => {
    await new Promise((done) =>
      requestAnimationFrame(() => requestAnimationFrame(done)),
    );
    const el = document.querySelector('.scroll') as HTMLElement;
    return {
      top: el.scrollTop,
      gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      height: (input as HTMLElement).offsetHeight,
    };
  });

test.describe('Composer growth at the bottom of a room', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
  test.use(DESIGN_VIEWPORTS['phone-pixel-5']);

  test('keeps a pinned reader on the newest message and leaves a reader who scrolled up', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const user = `growth-pin-${testResourceId('run')}`;
    const pass = `${user}-pass`;
    await registerUser(request, user, pass);
    const account = await apiLogin(request, hs, user, pass);
    const roomName = `Growth ${user}`;
    const roomId = await createRoom(request, hs, account, roomName);
    for (let i = 0; i < 20; i++) {
      await request.put(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${user}-${i}`,
        {
          headers: account.headers,
          data: { msgtype: 'm.text', body: `Row ${i} ${BURST.repeat(6)}` },
        },
      );
    }

    await login(page, { ...session, user, pass });
    await page.locator('.channel', { hasText: roomName }).first().click();
    const field = page.getByTestId('composer-input');
    await field.waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await settled(field)).gap).toBeLessThan(1);
    await field.click();

    const resting = await settled(field);
    const gaps: number[] = [];
    for (let i = 0; i < BURSTS; i++) {
      await field.pressSequentially(BURST);
      gaps.push((await settled(field)).gap);
    }
    const grown = await settled(field);
    // The draft really wrapped over several lines, else this proves nothing.
    expect(grown.height).toBeGreaterThan(resting.height + 40);
    expect(gaps.filter((gap) => gap >= 1)).toEqual([]);

    // Deleting lines still shrinks the field, with the reader on the newest message.
    await field.fill(BURST);
    const shrunk = await settled(field);
    expect(shrunk.height).toBeLessThan(grown.height);
    expect(shrunk.gap).toBeLessThan(1);

    // Slightly up is a reading position: the field keeps growing, the reader does not move.
    const up = await field.evaluate(() => {
      const el = document.querySelector('.scroll') as HTMLElement;
      el.scrollTop -= 3;
      return el.scrollTop;
    });
    for (let i = 0; i < BURSTS; i++) {
      await field.pressSequentially(BURST);
      expect((await settled(field)).top).toBe(up);
    }
  });
});
