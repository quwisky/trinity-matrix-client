import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test, testResourceId } from '../../../fixtures.mts';
import { login, type HomeserverSession } from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import {
  HS_SERVER_NAME,
  configureRoomSettingsSuite,
  openRoom,
  session,
  tokenFor,
} from '../../support/room-settings-journey.mts';
import { createRoom } from '../../support/space-journey.mts';
import { solidPng } from '../../support/png.mts';

interface Member {
  readonly user: string;
  readonly pass: string;
  readonly userId: string;
  readonly headers: Record<string, string>;
}

async function member(
  request: APIRequestContext,
  user: string,
): Promise<Member> {
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const token = await tokenFor(request, session.hs as string, user, pass);
  return {
    user,
    pass,
    userId: `@${user}:${HS_SERVER_NAME}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

async function openRoomSettings(
  page: Page,
  who: Member,
  roomName: string,
): Promise<void> {
  await login(page, {
    available: true,
    hs: session.hs,
    user: who.user,
    pass: who.pass,
  } as HomeserverSession);
  await openRoom(page, roomName);
  await page.getByTestId('room-actions-overflow').click();
  await page.getByTestId('overflow-open-room-settings').click();
  await expect(page.getByTestId('room-settings')).toBeVisible({
    timeout: 10_000,
  });
}

const tile = (page: Page, code: string) =>
  page.getByTestId('personal-pack-tile').and(page.getByLabel(`:${code}:`));

test.describe('Room emoji', () => {
  configureRoomSettingsSuite();

  test("an admin adds to a room's legacy pack, which moves to the stable type", async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const run = testResourceId('room-emoji');
    const admin = await member(request, `roomemoji-${run}`);
    const roomName = `Room emoji ${run}`;
    const roomId = await createRoom(
      request,
      hs,
      { accessToken: admin.headers.Authorization.slice('Bearer '.length) },
      roomName,
    );
    const state = (type: string) =>
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}/`;
    const old = await request
      .post(`${hs}/_matrix/media/v3/upload?filename=old.png`, {
        headers: { ...admin.headers, 'Content-Type': 'image/png' },
        data: solidPng(32, 32, [40, 160, 90]),
      })
      .then((response) => response.json())
      .then((json) => json.content_uri as string);
    const seeded = await request.put(state('im.ponies.room_emotes'), {
      headers: admin.headers,
      data: {
        pack: { display_name: 'Old pack' },
        images: { old: { url: old } },
      },
    });
    expect(seeded.ok()).toBe(true);

    await openRoomSettings(page, admin, roomName);
    await page.getByTestId('room-settings-tab-emoji').click();
    await expect(tile(page, 'old')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('personal-pack-files').setInputFiles({
      name: 'party.png',
      mimeType: 'image/png',
      buffer: solidPng(64, 64, [230, 120, 30]),
    });
    const dialog = page.getByTestId('add-to-pack-dialog');
    await expect(dialog).toContainText('Add to room emoji');
    await expect(page.getByTestId('add-to-pack-shortcode')).toHaveValue(
      'party',
    );
    await page.getByTestId('add-to-pack-confirm').click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    await expect(tile(page, 'party')).toBeVisible({ timeout: 20_000 });
    await expect(tile(page, 'old')).toBeVisible();

    const stable = await request
      .get(state('m.room.image_pack'), { headers: admin.headers })
      .then((response) => response.json());
    expect(Object.keys(stable.images).sort()).toEqual(['old', 'party']);
    expect(stable.pack.display_name).toBe('Old pack');
    const legacy = await request
      .get(state('im.ponies.room_emotes'), { headers: admin.headers })
      .then((response) => response.json());
    expect(Object.keys(legacy.images)).toEqual(['old']);
  });

  test('a member without the power to change it sees no Emoji section', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const run = testResourceId('room-emoji');
    const admin = await member(request, `roomowner-${run}`);
    const guest = await member(request, `roomguest-${run}`);
    const roomName = `Room emoji guest ${run}`;
    const roomId = await createRoom(
      request,
      hs,
      { accessToken: admin.headers.Authorization.slice('Bearer '.length) },
      roomName,
      { invite: [guest.userId] },
    );
    const joined = await request.post(
      `${hs}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      { headers: guest.headers, data: {} },
    );
    expect(joined.ok()).toBe(true);

    await openRoomSettings(page, guest, roomName);
    await expect(page.getByTestId('room-settings-tab-widgets')).toBeVisible();
    await expect(page.getByTestId('room-settings-tab-emoji')).toHaveCount(0);
  });
});
