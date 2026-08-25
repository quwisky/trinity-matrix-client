import { test, expect, type Page } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers quoting a message (msg-more → msg-quote): the message's text is pulled into the
// composer as a markdown `>` block for the user to write around, and sending it renders a
// real <blockquote> in the timeline.
//
// Distinct from replying, which points at the event without bringing its words: nothing
// here asserts an `m.in_reply_to` relation, because a quote deliberately creates none.
//
// The two-paragraph body is the load-bearing part of the fixture. CommonMark ends a
// blockquote at an unmarked blank line, so a naive "prefix each line with > " puts the
// second paragraph outside the quote — the rendered HTML is what proves it did not.
//
// Needs a Synapse homeserver (Docker) and self-skips otherwise.
const session = synapseSession();

async function openRoom(page: Page, roomName: string): Promise<void> {
  await page.getByTestId('rail-rooms').click();
  const channel = page.locator('.channel', { hasText: roomName });
  await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
  await channel.first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Quote a message', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('pulls a message into the composer as a > block and sends it as a blockquote', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}q`;
    const user = `quote-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Quote ${runId}`;
    const first = `alpha ${runId}`;
    const second = `omega ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: roomName, preset: 'private_chat' },
    });

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // Two paragraphs, sent with Shift+Enter so the body carries a real blank line.
    const composer = page.getByTestId('composer-input');
    await composer.fill(first);
    await composer.press('Shift+Enter');
    await composer.press('Shift+Enter');
    await composer.pressSequentially(second);
    await composer.press('Enter');

    const row = page.locator('.scroll .msg', { hasText: first });
    await expect(row.first()).toBeVisible({ timeout: 20_000 });

    await row.first().hover();
    await row.first().getByTestId('msg-more').click();
    await page.getByTestId('msg-quote').click();

    // Every line marked, INCLUDING the paragraph break, and a blank line at the end for
    // the reply to be typed on.
    await expect(composer).toHaveValue(`> ${first}\n>\n> ${second}\n\n`, {
      timeout: 10_000,
    });

    // Write the response the quote exists to frame, and send.
    const answer = `my point ${runId}`;
    await composer.pressSequentially(answer);
    await composer.press('Enter');

    const sent = page.locator('.scroll .msg', { hasText: answer });
    await expect(sent.first()).toBeVisible({ timeout: 20_000 });

    // The markdown really became a blockquote, and BOTH paragraphs are inside it. Only a
    // real render can show that: an unmarked blank line would have left "omega" as the
    // quoter's own words, and the plain-text body would look identical either way.
    const quoted = sent.first().locator('blockquote');
    await expect(quoted).toHaveCount(1);
    await expect(quoted).toContainText(first);
    await expect(quoted).toContainText(second);
    // The answer sits outside the quote.
    await expect(quoted).not.toContainText(answer);
  });

  test('offers no Quote for a message with no text to bring', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}qn`;
    const user = `quoten-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Quote none ${runId}`;
    const body = `plain ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);
    const roomId = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json())
      .then((j) => j.room_id as string);

    // An image message: its body is the filename, so there is nothing worth quoting.
    // Sent over the API rather than through the picker — this test is about the menu.
    const mxc = await request
      .post(`${hs}/_matrix/media/v3/upload?filename=shot.png`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'image/png',
        },
        // A 1x1 PNG.
        data: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      })
      .then((r) => r.json())
      .then((j) => j.content_uri as string);
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${runId}img`,
      {
        headers: { Authorization: `Bearer ${token}` },
        data: { msgtype: 'm.image', body: 'shot.png', url: mxc },
      },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await openRoom(page, roomName);

    // A text message in the same room, as the control: the menu itself is fine, it is the
    // image row that must not offer Quote.
    const composer = page.getByTestId('composer-input');
    await composer.fill(body);
    await composer.press('Enter');

    const textRow = page.locator('.scroll .msg', { hasText: body });
    await expect(textRow.first()).toBeVisible({ timeout: 20_000 });
    await textRow.first().hover();
    await textRow.first().getByTestId('msg-more').click();
    await expect(page.getByTestId('msg-quote')).toBeVisible({
      timeout: 10_000,
    });
    await page.keyboard.press('Escape');

    const imageRow = page.locator('.scroll .msg', { hasText: 'shot.png' });
    await expect(imageRow.first()).toBeVisible({ timeout: 20_000 });
    await imageRow.first().hover();
    await imageRow.first().getByTestId('msg-more').click();

    // Same menu, no Quote — proving the cap is per-message and not merely absent.
    await expect(page.getByTestId('msg-copy')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('msg-quote')).toHaveCount(0);
  });
});
