import {
  testResourceId,
  test,
  expect,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  synapseSession,
  type SynapseSession,
} from '../../../support/app.mts';
import { registerUser } from '../../../support/account.mts';
import { captureScreenshot } from '../../../support/screenshot.mts';

// Covers the desktop edit-history frame: the "(edited)" marker (message-row
// `data-testid="msg-edited"`) opens a settings-style dialog with a fixed header, and the
// dialog turns into a fullscreen surface at the compact breakpoint. The revision
// lifecycle and the phone surface run through android.edit-history (#743).
//
// Seeded over the Client-Server API rather than through the composer, because the point
// under test is what the client does with a chain of `m.replace` events — building that
// chain by hand keeps the versions and their order deterministic.
// Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

async function seedHistory(
  request: APIRequestContext,
  hs: string,
  runId: string,
): Promise<{
  user: string;
  pass: string;
  roomName: string;
  original: string;
  versions: string[];
}> {
  const user = `edits-${runId}`;
  const pass = `${user}-pass`;
  const roomName = `Edits ${runId}`;
  const tail = ` ${runId} `;
  const versions = [
    `first draft${tail}${'long content '.repeat(60)}`,
    `second draft${tail}${'long content '.repeat(60)}`,
    `final wording${tail}${'long content '.repeat(60)}`,
  ];
  await registerUser(request, user, pass);
  const { access_token } = await request
    .post(`${hs}/_matrix/client/v3/login`, {
      data: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password: pass,
      },
    })
    .then((r) => r.json());
  const headers = { Authorization: `Bearer ${access_token}` };
  const { room_id } = await request
    .post(`${hs}/_matrix/client/v3/createRoom`, {
      headers,
      data: { name: roomName, preset: 'private_chat' },
    })
    .then((r) => r.json());
  const room = encodeURIComponent(room_id);
  const send = async (txn: string, content: Record<string, unknown>) => {
    const { event_id } = await request
      .put(`${hs}/_matrix/client/v3/rooms/${room}/send/m.room.message/${txn}`, {
        headers,
        data: content,
      })
      .then((r) => r.json());
    return event_id as string;
  };
  const edit = (target: string, body: string) => ({
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  });
  const original = await send(`${runId}-orig`, {
    msgtype: 'm.text',
    body: versions[0],
  });
  await send(`${runId}-edit1`, edit(original, versions[1]));
  await send(`${runId}-edit2`, edit(original, versions[2]));
  return { user, pass, roomName, original, versions };
}

async function openSeededHistory(
  page: Page,
  request: APIRequestContext,
  runId: string,
) {
  const hs = session.hs as string;
  const seeded = await seedHistory(request, hs, runId);
  await login(page, {
    available: true,
    hs,
    user: seeded.user,
    pass: seeded.pass,
  } as SynapseSession);
  await page.getByTestId('rail-rooms').click();
  const channel = page
    .locator('.channel', { hasText: seeded.roomName })
    .first();
  await expect(channel).toBeVisible({ timeout: 30_000 });
  await channel.click();
  const row = page.locator(`[data-mid="${seeded.original}"]`);
  await expect(row.locator('.msg__text')).toHaveText(seeded.versions[2], {
    timeout: 30_000,
  });
  await row.getByRole('button', { name: /edited/i }).click();
  const dialog = page.getByTestId('edit-history');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  return { seeded, row, dialog };
}

test.describe('Edit history', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('uses a settings-style frame with a fixed header and scrolling revisions', async ({
    page,
    request,
  }) => {
    const { row, dialog } = await openSeededHistory(
      page,
      request,
      `${testResourceId('run')}layout`,
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();

    const header = dialog.locator('header');
    await expect(header).toBeVisible();
    await expect(
      header.getByRole('heading', { name: 'Edit history' }),
    ).toBeVisible();
    await expect(header.getByTestId('edit-history-close')).toBeVisible();
    await expect(dialog.locator('footer')).toHaveCount(0);
    const toggle = dialog.getByTestId('edit-history-toggle');
    await expect(toggle).toBeVisible();
    expect((await toggle.boundingBox())!.y).toBeGreaterThan(
      (await header.boundingBox())!.y,
    );

    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.width).toBeLessThan(viewport!.width);
    expect(dialogBox!.height).toBeLessThanOrEqual(viewport!.height + 1);
    const revisions = dialog.locator('.revisions');
    await expect
      .poll(() => revisions.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    const headerY = (await header.boundingBox())!.y;
    const toggleY = (await toggle.boundingBox())!.y;
    await revisions.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(async () => (await header.boundingBox())!.y)
      .toBe(headerY);
    await expect
      .poll(async () => (await toggle.boundingBox())!.y)
      .toBe(toggleY);
    await page.keyboard.press('Tab');
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await test.info().attach('edit-history-settings-style', {
      body: await captureScreenshot(page, () => dialog.screenshot()),
      contentType: 'image/png',
    });

    // Closing returns keyboard focus to the edited marker that opened the dialog.
    await header.getByTestId('edit-history-close').click();
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId('msg-edited')).toBeFocused();

    // Crossing the compact viewport breakpoint also turns the desktop card into a
    // fullscreen surface, and the close control remains in the fixed header.
    await row.getByTestId('msg-edited').click();
    await page.setViewportSize({ width: 767, height: viewport!.height });
    await expect(dialog).toHaveAttribute('data-compact', 'true');
    await expect
      .poll(async () => (await dialog.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(766);
    await expect(
      dialog.locator('header').getByTestId('edit-history-close'),
    ).toBeVisible();
    await expect
      .poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    await header.getByTestId('edit-history-close').click();
    await expect(dialog).toBeHidden();

    await page.setViewportSize(viewport!);
    // The 48rem text-scaled breakpoint is exercised by changing the document text size,
    // which a jsdom test cannot observe. At 32px, the same desktop viewport is compact.
    await row.getByTestId('msg-edited').click();
    await expect(dialog).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
      window.dispatchEvent(new Event('resize'));
    });
    await expect(dialog).toHaveAttribute('data-compact', 'true');
    await expect
      .poll(async () => (await dialog.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(viewport!.width - 1);
    await expect
      .poll(async () => (await dialog.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(viewport!.height - 1);
    await header.getByTestId('edit-history-close').click();
    await page.evaluate(() => {
      document.documentElement.style.removeProperty('font-size');
      window.dispatchEvent(new Event('resize'));
    });
  });
});
