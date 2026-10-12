import {
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../fixtures.mts';
import { waitForRooms, type HomeserverSession } from '../../support/app.mts';
import { registerUser, type AccountSession } from '../../support/account.mts';

// Encryption steps the trust journeys share: a throwaway account, an encrypted room made
// over the API, first-device setup through the app, and opening a room by name. Never logs
// tokens, passwords or recovery keys.

/** A throwaway account registered for one test attempt. */
export interface FreshAccount {
  readonly hs: string;
  readonly user: string;
  readonly pass: string;
  readonly asSession: HomeserverSession;
}

/** Register `<prefix>-<attempt id>`; the same prefix within one attempt is the same user. */
export async function freshAccount(
  request: APIRequestContext,
  hs: string,
  prefix: string,
): Promise<FreshAccount> {
  const user = `${prefix}-${testResourceId('run')}`;
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  return {
    hs,
    user,
    pass,
    asSession: { available: true, hs, user, pass } as HomeserverSession,
  };
}

/** Create a private, encrypted room owned by `account`; returns its id. */
export async function createEncryptedRoom(
  request: APIRequestContext,
  hs: string,
  account: AccountSession,
  name: string,
): Promise<string> {
  const res = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
    data: {
      name,
      preset: 'private_chat',
      initial_state: [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
      ],
    },
  });
  if (!res.ok()) {
    throw new Error(`createRoom failed with status ${res.status()}`);
  }
  return ((await res.json()) as { room_id: string }).room_id;
}

/** Answer the device-signing password prompt if the server asks for it. */
export async function answerUiaIfAsked(
  page: Page,
  password: string,
  settled: () => Promise<unknown>,
): Promise<void> {
  // Scoped by its own copy, not just the element: the confirmation gate is the same
  // component and may still be detaching when this is called, which would either match
  // the wrong dialog (and time out filling a text input as a password) or trip strict
  // mode with two of them on screen.
  const uia = page.locator('trn-alert-dialog', {
    hasText: 'Confirm your password',
  });
  const outcome = await Promise.race([
    uia
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'uia')
      .catch(() => null),
    settled()
      .then(() => 'done')
      .catch(() => null),
  ]);
  if (outcome === 'uia') {
    await uia.locator('input[type="password"]').fill(password);
    await uia.getByRole('button', { name: 'Confirm' }).click();
  }
}

/** First-device setup through the app; returns the recovery key it showed once. */
export async function setUpEncryption(
  page: Page,
  password: string,
): Promise<string> {
  await page.goto('/encryption/setup', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Set up encryption' }).click();
  const key = page.getByTestId('recovery-key');
  await answerUiaIfAsked(page, password, () =>
    key.waitFor({ state: 'visible', timeout: 30_000 }),
  );
  await key.waitFor({ state: 'visible', timeout: 60_000 });
  const shown = (await key.innerText()).trim();
  await page
    .getByRole('checkbox', { name: /I’ve saved my recovery key/ })
    .click();
  await page.getByRole('button', { name: 'Continue to Trinity' }).click();
  await waitForRooms(page);
  return shown;
}

// Opening a room by name already has one helper; the trust journeys reuse it.
export { openRoom } from './room-settings-journey.mts';
