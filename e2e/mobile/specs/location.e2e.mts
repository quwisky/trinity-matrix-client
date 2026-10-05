import { browser, expect } from '@wdio/globals';
import { HOMESERVER_HTTP } from '../../support/homeserver/start.mjs';
import { login, tap } from '../support/app.mts';
import {
  accessToken,
  createRoom,
  registerUser,
  uniqueId,
} from '../support/matrix.mts';
import {
  APP_PACKAGE,
  native,
  resetApp,
  shell,
  webview,
} from '../support/session.mts';

// Budapest: distinct from the emulator's default fix and from the browser suite's New York.
const LAT = 47.49801;
const LNG = 19.04075;
const PERMISSIONS = ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION'];
const CONTROLLER = 'com.android.permissioncontroller:id';

const permissionButton = (id: string) =>
  $(`android=new UiSelector().resourceId("${CONTROLLER}/${id}")`);

/** Signed in, in a fresh room, with a deterministic fix and no location permission. */
async function seedLocationRoom(): Promise<{ token: string; roomId: string }> {
  const user = uniqueId('android-location');
  const pass = `${user}-pass`;
  const roomName = `Android location ${user}`;
  await registerUser(user, pass);
  const token = await accessToken(user, pass);
  const roomId = await createRoom(token, roomName);
  await login(user, pass);

  // Location services must be on for the fix to resolve; the mock provider supplies it.
  await native();
  await shell('cmd', ['location', 'set-location-enabled', 'true']);
  await browser.execute('mobile: setGeolocation', {
    latitude: LAT,
    longitude: LNG,
    altitude: 0,
  });
  // `pm clear` already drops runtime grants; revoke explicitly so the prompt is certain.
  for (const permission of PERMISSIONS) {
    await shell('pm', [
      'revoke',
      APP_PACKAGE,
      `android.permission.${permission}`,
    ]);
  }
  await webview();

  await tap('[data-testid="rail-rooms"]');
  const room = $(
    `//button[contains(@class,"channel")][contains(.,"${roomName}")]`,
  );
  await expect(room).toBeDisplayed({ wait: 30_000 });
  await room.click();
  await expect($('[data-testid="composer-input"]')).toBeDisplayed({
    wait: 15_000,
  });
  return { token, roomId };
}

/** Trigger Location from the composer's insert sheet and wait for the OS prompt. */
async function shareLocationAndWaitForPrompt(): Promise<void> {
  await tap('[data-testid="composer-insert"]');
  await tap('[data-testid="insert-location"]');
  await native();
  await expect(
    permissionButton('permission_allow_foreground_only_button'),
  ).toBeDisplayed({
    wait: 30_000,
  });
  await expect(
    permissionButton('permission_allow_one_time_button'),
  ).toBeDisplayed();
  await expect(permissionButton('permission_deny_button')).toBeDisplayed();
}

/** Press a prompt button until the dialog is gone; false if it ignored every press. */
async function pressUntilGone(id: string): Promise<boolean> {
  // A press can miss while the dialog animates in, so allow a few.
  for (let press = 0; press < 5; press += 1) {
    const button = permissionButton(id);
    if (!(await button.isExisting())) return true;
    await button.click().catch(() => undefined);
    await browser.pause(1_000);
  }
  return !(await permissionButton(id).isExisting());
}

/**
 * Android occasionally drops the prompt's input channel just after drawing it: the
 * activity stays in the hierarchy but its window is gone and every tap is discarded
 * (`InputDispatcher: … NO_INPUT_CHANNEL`). Finishing the controller cancels the request,
 * which the app reports as a denial, so wait for that message to clear before the caller
 * prompts again; otherwise a denial assertion could pass on the cancellation alone.
 */
async function dismissStuckPrompt(): Promise<void> {
  for (const controller of [
    'com.google.android.permissioncontroller',
    'com.android.permissioncontroller',
  ]) {
    await shell('am', ['force-stop', controller]);
  }
  await expect(permissionButton('permission_deny_button')).not.toExist({
    wait: 10_000,
  });
  await webview();
  const cancelled = $(
    '//*[contains(normalize-space(.),"Location permission request was denied.")]',
  );
  await cancelled.waitForExist({ timeout: 10_000 }).catch(() => undefined);
  await cancelled.waitForExist({ timeout: 15_000, reverse: true });
}

/** Answer the location prompt, re-prompting if Android left it unable to take input. */
async function answerPrompt(id: string): Promise<void> {
  const prompts = 3;
  for (let prompt = 1; ; prompt += 1) {
    if (await pressUntilGone(id)) return;
    if (prompt === prompts) {
      throw new Error(
        `the permission prompt ignored ${id} on ${prompts} prompts; Android dropped its input channel`,
      );
    }
    console.log(
      `[mobile] location prompt ignored ${id} (prompt ${prompt}); dismissing and re-prompting`,
    );
    await dismissStuckPrompt();
    await shareLocationAndWaitForPrompt();
  }
}

async function sentGeoUri(token: string, roomId: string): Promise<string> {
  const url = `${HOMESERVER_HTTP}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=10`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { chunk } = (await res.json()) as {
    chunk: { content?: { msgtype?: string; geo_uri?: string } }[];
  };
  const sent = chunk.find((e) => e.content?.msgtype === 'm.location');
  if (!sent?.content?.geo_uri)
    throw new Error('no m.location event in the room');
  return sent.content.geo_uri;
}

describe('Android location', () => {
  beforeEach(resetApp);

  it('prompts for location, then sends the mocked position as an m.location message', async () => {
    const { token, roomId } = await seedLocationRoom();
    await shareLocationAndWaitForPrompt();
    await answerPrompt('permission_allow_foreground_only_button');
    await webview();

    const card = $('[data-testid="location-card"]');
    await expect(card).toBeDisplayed({ wait: 60_000 });
    await expect(card).toHaveText(
      expect.stringContaining('47.49801, 19.04075'),
    );

    await browser.waitUntil(
      async () => {
        try {
          const match = /^geo:(-?[\d.]+),(-?[\d.]+)/.exec(
            await sentGeoUri(token, roomId),
          );
          return (
            !!match &&
            Math.abs(Number(match[1]) - LAT) < 1e-4 &&
            Math.abs(Number(match[2]) - LNG) < 1e-4
          );
        } catch {
          return false;
        }
      },
      {
        timeout: 20_000,
        timeoutMsg: 'the sent geo_uri never matched the mock',
      },
    );
  });

  it('reports a denied location prompt without sending or crashing', async () => {
    const { token, roomId } = await seedLocationRoom();
    await shareLocationAndWaitForPrompt();
    await answerPrompt('permission_deny_button');
    await webview();

    await expect(
      $(
        '//*[contains(normalize-space(.),"Location permission request was denied.")]',
      ),
    ).toBeDisplayed({ wait: 20_000 });
    await expect($('[data-testid="location-card"]')).not.toExist();
    await expect($('[data-testid="composer-input"]')).toBeDisplayed();
    await expect(sentGeoUri(token, roomId)).rejects.toThrow('no m.location');
  });
});
