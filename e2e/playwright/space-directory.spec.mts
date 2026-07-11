import { createHmac } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { login, synapseSession, type SynapseSession } from './support/app.mts';

// Covers browsing the public directory for Spaces: the Home "+" → "Explore public rooms"
// opens the directory dialog (data-testid="room-directory"), whose Rooms/Spaces toggle
// (data-testid="directory-mode-spaces") restricts the search to m.space entries. One user
// publishes a public Space; another switches to Spaces, finds it, and joins — it lands in
// the server rail and becomes the selected space. Needs a Synapse homeserver (Docker);
// self-skips otherwise.
const session = synapseSession();

const SYNAPSE_HTTP = 'http://localhost:8008';
const REG_SECRET = 'trinity-e2e-shared-secret';

async function registerUser(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<void> {
  const { nonce } = await request
    .get(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`)
    .then((r) => r.json());
  const mac = createHmac('sha1', REG_SECRET)
    .update(`${nonce}\0${username}\0${password}\0notadmin`)
    .digest('hex');
  const res = await request.post(`${SYNAPSE_HTTP}/_synapse/admin/v1/register`, {
    data: { nonce, username, password, admin: false, mac },
  });
  if (!res.ok()) {
    const text = await res.text();
    if (!/already.*exists|user.*taken/i.test(text)) {
      throw new Error(`register ${username} → ${res.status()} ${text}`);
    }
  }
}

test.describe('Space directory', () => {
  test.skip(!session.available, 'needs a Synapse homeserver (Docker)');

  test('finds a public space in the directory and joins it', async ({
    page,
    request,
  }) => {
    const hs = session.hs as string;
    const runId = `${Date.now().toString(36)}spc`;
    const owner = `spc-owner-${runId}`;
    const ownerPass = `${owner}-pass`;
    const joiner = `spc-joiner-${runId}`;
    const joinerPass = `${joiner}-pass`;
    const spaceName = `Galaxy ${runId}`;

    await registerUser(request, owner, ownerPass);
    await registerUser(request, joiner, joinerPass);
    const ownerToken = await request
      .post(`${hs}/_matrix/client/v3/login`, {
        data: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: owner },
          password: ownerPass,
        },
      })
      .then((r) => r.json())
      .then((j) => j.access_token as string);

    // Publish a public, directory-listed Space the joiner can discover.
    await request.post(`${hs}/_matrix/client/v3/createRoom`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
      data: {
        name: spaceName,
        preset: 'public_chat',
        visibility: 'public',
        creation_content: { type: 'm.space' },
      },
    });

    await login(page, {
      available: true,
      hs,
      user: joiner,
      pass: joinerPass,
    } as SynapseSession);

    // Home "+" → the new-message action sheet → Explore public rooms.
    await page.click('button[aria-label="New room or direct message"]');
    const sheet = page.locator('trn-action-sheet');
    await sheet.waitFor({ state: 'visible', timeout: 15_000 });
    await sheet.getByRole('button', { name: 'Explore public rooms' }).click();

    // The directory dialog opens; switch to Spaces and search by name.
    await expect(page.getByTestId('room-directory')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('directory-mode-spaces').click();
    await page.getByTestId('directory-search').fill(spaceName);
    await page.getByTestId('directory-search-btn').click();

    const row = page
      .getByTestId('directory-room')
      .filter({ hasText: spaceName });
    await expect(row).toBeVisible({ timeout: 20_000 });

    // Join it; the dialog closes and the space lands in the rail as the active space.
    await row.getByTestId('directory-join').click();
    const pill = page.locator(`nav.rail button[aria-label="${spaceName}"]`);
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await expect(pill).toHaveAttribute('aria-current', 'true', {
      timeout: 30_000,
    });
  });
});
