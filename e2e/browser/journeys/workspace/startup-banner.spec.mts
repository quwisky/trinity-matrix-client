import { test, expect, type Page } from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import { describeFailure } from '../../../support/http-failure.mts';

const session = homeserverSession();

/** One animation frame: the first room row's top, and which global banner held the slot. */
interface SlotFrame {
  readonly t: number;
  readonly row: number | null;
  readonly slot: 'status' | 'encryption' | null;
}

declare global {
  interface Window {
    __slotFrames?: SlotFrame[];
  }
}

/** Installed before the app loads: record every frame until the test reads the list. */
function recordSlotFrames(): void {
  const frames: SlotFrame[] = [];
  window.__slotFrames = frames;
  const frame = (): void => {
    const row = document.querySelector('button.channel');
    frames.push({
      t: Math.round(performance.now()),
      row: row ? row.getBoundingClientRect().top : null,
      slot: document.querySelector('trn-encryption-banner trn-banner')
        ? 'encryption'
        : document.querySelector('[data-testid="app-capability-summary"]')
          ? 'status'
          : null,
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Frames from the first one that drew a room row, a couple of frames past `settled`. */
async function framesWithRow(page: Page): Promise<SlotFrame[]> {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const frames = await page.evaluate(() => window.__slotFrames ?? []);
  return frames.slice(frames.findIndex((frame) => frame.row !== null));
}

/*
 * Signing in at phone width, the global banner slot first holds the "Protected browser
 * storage is unavailable" notice (the browser declines persistent storage) and swaps it for
 * the "Set up encryption" prompt once the trust status arrives, a fraction of a second after
 * Rooms renders. The notice's two actions wrap under its message there and the prompt's one
 * action does not, so the swap used to move the room list up by about 26px, under a tap
 * already in flight: the tap was lost or opened the next room. Every frame from the first
 * room row until the prompt is up has to show the row in the same place.
 */
test.describe('Global banner slot after sign-in', () => {
  test.skip(
    !session.available,
    'requires the disposable homeserver (Docker or native Synapse)',
  );

  let account: HomeserverSession;

  test.beforeAll(async ({ request, workerResourceNamespace }) => {
    const runId = workerResourceNamespace.role('startup-banner');
    const user = `banner-user-${runId}`;
    const pass = `${user}-pass`;
    const hs = session.hs as string;
    account = { available: true, hs, user, pass };
    await registerUser(request, user, pass);
    const { accessToken, userId } = await passwordLogin(
      request,
      hs,
      user,
      pass,
    );
    const headers = { Authorization: `Bearer ${accessToken}` };
    const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: `Banner room ${runId}` },
    });
    if (!created.ok()) {
      throw new Error(await describeFailure('createRoom', created));
    }
    const { room_id: roomId } = (await created.json()) as { room_id: string };
    // A direct message, so the room is in the default Home list without switching views.
    const direct = await request.put(
      `${hs}/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/m.direct`,
      { headers, data: { '@ghost:localhost': [roomId] } },
    );
    if (!direct.ok()) {
      throw new Error(await describeFailure('m.direct', direct));
    }
  });

  for (const width of [320, 390, 1280]) {
    test(`the room list stays put while the slot settles at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript(recordSlotFrames);
      await login(page, account);
      // A fresh account has no encryption set up: the prompt is where the slot settles.
      await expect(
        page
          .locator('trn-encryption-banner trn-banner')
          .getByText('Set up encryption to secure your messages.'),
      ).toBeVisible();

      const frames = await framesWithRow(page);
      expect(frames.length).toBeGreaterThan(0);
      const first = frames[0]!;
      const moved = frames.filter(
        (frame) => frame.row === null || Math.abs(frame.row - first.row!) > 0.5,
      );
      const swaps = frames.filter(
        (frame, index) => index === 0 || frame.slot !== frames[index - 1]!.slot,
      );
      expect(
        moved,
        `row first drawn at y=${first.row}; slot changes: ${JSON.stringify(swaps)}`,
      ).toEqual([]);
    });
  }
});
