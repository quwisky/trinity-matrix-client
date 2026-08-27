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
    const destination = `${OG_URL}?asset=image_name.jpg`;
    const markdown = `[${destination}](${destination})`;
    const escapedDestination = destination.replaceAll('_', '\\_');
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
        },
      },
    );
    expect(sent.ok()).toBe(true);

    await login(page, { available: true, hs, user, pass } as SynapseSession);
    await page.getByTestId('rail-rooms').click();
    const channel = page.locator('.channel', { hasText: roomName });
    await channel.first().waitFor({ state: 'visible', timeout: 30_000 });
    await channel.first().click();

    const messageLink = page.getByRole('link', {
      name: destination,
      exact: true,
    });
    await expect(messageLink).toBeVisible({ timeout: 20_000 });
    await expect(messageLink).toHaveAttribute('href', destination);
    const message = page.locator('.scroll .msg').filter({ has: messageLink });
    await expect(message).not.toContainText('](');

    const card = page.getByTestId('link-preview');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText('Trinity E2E Preview');
    await expect(card).toHaveAttribute('href', destination);
  });
});
