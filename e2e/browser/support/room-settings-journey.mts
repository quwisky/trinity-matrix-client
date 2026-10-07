import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '../../fixtures.mts';
import { homeserverSession } from '../../support/app.mts';

// Covers editing a room's settings: the room header's ⚙ button
// (data-testid="open-room-settings") opens a dialog (data-testid="room-settings")
// with Name/Topic fields, gated by the viewer's power level. As the room creator
// (admin), the reader renames the room; the new name round-trips through
// RoomSettingsService.setName → setRoomName → sync and re-labels the room.
// Needs a Synapse homeserver (Docker); self-skips otherwise.
export const session = homeserverSession();

/** Log in over the API and return the access token. */
export async function tokenFor(
  request: APIRequestContext,
  hs: string,
  user: string,
  pass: string,
): Promise<string> {
  const json = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  return json.access_token as string;
}

export async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

export const HS_SERVER_NAME = 'localhost';

/**
 * Create a space and link `roomId` into it as a child (`m.space.child` with a non-empty
 * `via`, the shape SpacesService.orderedChildIds requires), so the room has a parent space
 * for the `restricted` join rule to point at.
 */
export async function linkIntoSpace(
  request: APIRequestContext,
  hs: string,
  token: string,
  spaceName: string,
  roomId: string,
): Promise<string> {
  const spaceId = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      },
    })
    .then((r) => r.json())
    .then((j) => j.room_id as string);
  const res = await request.put(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { via: [HS_SERVER_NAME], suggested: true },
    },
  );
  if (!res.ok()) {
    throw new Error(`m.space.child → ${res.status()} ${await res.text()}`);
  }
  return spaceId;
}

/** Register the shared disposable-homeserver requirement for focused specs. */
export function configureRoomSettingsSuite(): void {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');
}

/**
 * Every settings row label starts where the section title starts: inline padding comes from
 * the content column only, so a group, row or card must add none.
 */
export async function expectRowLabelsAlignedWithTitle(
  page: Page,
  settingsTestId: 'room-settings' | 'space-settings',
): Promise<void> {
  // Rows line up with the page's leading edge: the title's, or, where a sheet puts the
  // title beside Back on one row, that row's.
  const heading = page.getByTestId(`${settingsTestId}-section-heading`);
  const topbar = page
    .locator('.settings-layout__topbar')
    .filter({ has: heading });
  const title = await ((await topbar.count()) > 0
    ? topbar.boundingBox()
    : heading.boundingBox());
  expect(title).not.toBeNull();
  const labels = page.locator(
    `[data-testid="${settingsTestId}"] [data-slot="settings-row"] label`,
  );
  const count = await labels.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index++) {
    const box = await labels.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x - title!.x)).toBeLessThanOrEqual(1);
  }
}

/** On a phone, Room and Space settings are the shared bottom sheet, across the full width. */
export async function expectSettingsSheet(
  page: Page,
  settingsTestId: 'room-settings' | 'space-settings',
): Promise<void> {
  const surface = page
    .getByTestId(settingsTestId)
    .locator('xpath=ancestor::*[@data-testid="dialog-surface"]');
  await expect(surface).toHaveAttribute('data-trn-layout', 'sheet');
  await surface.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  const box = await surface.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeGreaterThanOrEqual(viewport.width - 1);
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport.height - 1);
}
