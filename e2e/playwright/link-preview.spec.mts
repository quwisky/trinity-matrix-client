import { test, expect } from './support/fixtures.mts';
import { login, synapseSession, type SynapseSession } from './support/app.mts';
import { registerUser } from './support/account.mts';

// Covers link previews (message-row `data-testid="link-preview"`): a URL in an
// unencrypted message shows an Open-Graph card fetched via the homeserver
// (UrlPreviewService.preview → getUrlPreview). The harness Caddy serves a fixed OG page
// at http://caddy:8080/og that Synapse (url previews enabled) can fetch server-side, so
// the card is deterministic and offline. In E2EE rooms previews are suppressed (unit-
// tested) to avoid disclosing the URL. Needs a Synapse homeserver (Docker); self-skips.
const session = synapseSession();

// Reachable by Synapse on the docker network; the browser never fetches it.
// Fetched by Synapse server-side. On the compose network that is the `caddy` hostname;
// when the stack shares the job container's network namespace (containerised CI) there is
// no compose DNS and everything is on one loopback instead.
const OG_URL = process.env['TRINITY_E2E_NETWORK_CONTAINER']
  ? 'http://localhost:8080/og'
  : 'http://caddy:8080/og';

test.describe('Link previews', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('shows an Open-Graph card for a link in an unencrypted room', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}lp`;
    const user = `lp-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Links ${runId}`;

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
    const auth = { Authorization: `Bearer ${token}` };

    // A plaintext (unencrypted) room so previews are allowed.
    const { room_id } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((r) => r.json());
    await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${runId}-msg`,
      { headers: auth, data: { msgtype: 'm.text', body: `look: ${OG_URL}` } },
    );

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    // The preview card resolves from the homeserver's OG fetch of the harness page.
    const card = page.getByTestId('link-preview');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Trinity E2E Preview');
    await expect(card).toHaveAttribute('href', OG_URL);
  });

  test('recovers a Markdown link mislabeled as custom HTML', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}ml`;
    const user = `markdown-link-user-${runId}`;
    const pass = `${user}-pass`;
    const roomName = `Markdown link ${runId}`;

    await registerUser(request, user, pass);
    const token = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user },
          password: pass,
        },
      })
      .then((response) => response.json())
      .then((json) => json.access_token as string);
    const auth = { Authorization: `Bearer ${token}` };
    const { room_id: roomId } = await request
      .post(`${hs}/_matrix/client/v3/createRoom`, {
        headers: auth,
        data: { name: roomName, preset: 'private_chat' },
      })
      .then((response) => response.json());
    const destination =
      `${OG_URL}?asset=Control_-_Safeer_Abbas_-_` +
      'Powerplant_enviromental_art_1.jpg';
    const markdown = `[${destination}](${destination})`;
    // The reported fallback contains two decoded backslashes before each underscore.
    // The valid formatted body is authoritative, so that malformed fallback must not
    // prevent rendering or make the history repair poison the live event.
    const escapedDestination = destination.replaceAll('_', String.raw`\\_`);
    const fallbackMarkdown = `[${escapedDestination}](${escapedDestination})`;
    const sent = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-msg`,
      {
        headers: auth,
        data: {
          msgtype: 'm.text',
          body: fallbackMarkdown,
          format: 'org.matrix.custom.html',
          formatted_body: markdown,
          'm.mentions': {},
        },
      },
    );
    expect(sent.ok()).toBe(true);
    const { event_id: eventId } = (await sent.json()) as { event_id: string };

    const received = await request
      .get(
        `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
        { headers: auth },
      )
      .then((response) => response.json());
    expect(received.content).toMatchObject({
      body: fallbackMarkdown,
      format: 'org.matrix.custom.html',
      formatted_body: markdown,
      'm.mentions': {},
      msgtype: 'm.text',
    });

    const edit = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-edit`,
      {
        headers: auth,
        data: {
          msgtype: 'm.text',
          body: `* ${fallbackMarkdown}`,
          'm.new_content': {
            msgtype: 'm.text',
            body: `[Updated Wikia link](${destination})`,
            format: 'org.matrix.custom.html',
            formatted_body: `[Updated Wikia link](${destination})`,
            'm.mentions': {},
          },
          'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
        },
      },
    );
    expect(edit.ok()).toBe(true);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    const messageLink = page.getByRole('link', {
      name: 'Updated Wikia link',
      exact: true,
    });
    await expect(messageLink).toBeVisible({ timeout: 20_000 });
    await expect(messageLink).toHaveAttribute('href', destination);
    const message = page.locator(`[data-mid="${eventId}"]`);
    await expect(message).not.toContainText('](');

    const card = page.getByTestId('link-preview');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Trinity E2E Preview');
    await expect(card).toHaveAttribute('href', destination);

    // Introduce the server event that caused the reported second-stage failure only
    // after the readable row is on screen. The SDK may aggregate it from sync or while
    // `/relations` is fetched below; either way, an array cannot replace the live text.
    const malformedEdit = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-malformed-edit`,
      {
        headers: auth,
        data: {
          msgtype: 'm.text',
          body: '* malformed',
          'm.new_content': [],
          'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
        },
      },
    );
    expect(malformedEdit.ok()).toBe(true);

    // A later event in the same room proves the malformed edit crossed /sync and was
    // processed before any history fetch can repair SDK aggregation.
    const sentinelBody = `after-malformed-${runId}`;
    const sentinel = await request.put(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${runId}-sentinel`,
      {
        headers: auth,
        data: { msgtype: 'm.text', body: sentinelBody },
      },
    );
    expect(sentinel.ok()).toBe(true);
    await expect(
      page.locator('.msg__text').filter({ hasText: sentinelBody }),
    ).toHaveText(sentinelBody, { timeout: 20_000 });
    await expect(messageLink).toBeVisible();

    await message.getByRole('button', { name: /edited/i }).click();
    const history = page.getByTestId('edit-history');
    await expect(history).toBeVisible({ timeout: 20_000 });
    await expect(history.locator('.revision')).toHaveCount(2);
    await expect(
      history.getByRole('link', { name: destination, exact: true }),
    ).toHaveCount(1);
    await expect(
      history.locator('ins').filter({ hasText: 'Updated Wikia link' }),
    ).toHaveCount(1);
    await expect(history.getByRole('link')).toHaveCount(2);
    await page.getByTestId('edit-history-close').click();

    await expect(message).not.toContainText('[unsupported message]');
    await expect(messageLink).toBeVisible();
  });
});
