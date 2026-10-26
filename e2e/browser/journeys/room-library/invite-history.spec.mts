import {
  expect,
  test,
  testResourceId,
  type APIRequestContext,
  type Page,
} from '../../../fixtures.mts';
import {
  login,
  homeserverSession,
  type HomeserverSession,
} from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';
import { setUpEncryption } from '../../support/encryption-journey.mts';

// Covers sharing an encrypted room's earlier messages with someone invited from Trinity, and the
// invite dialog's note about it. The SDK shares history once, at invite, only from a device its
// own identity has verified and only to the invitee's cross-signed devices: so both accounts set
// up encryption first, and the note says when the inviter's device is what is missing.
// Needs a Synapse homeserver; self-skips otherwise.
const session = homeserverSession();

const rowOf = (page: Page, text: string) =>
  page.locator('.msg', { has: page.locator('.msg__text', { hasText: text }) });

type Visibility = 'shared' | 'joined';

/** Alice and Bob, both signed in to Trinity, and an encrypted room of Alice's. */
async function setUp(
  page: Page,
  bobPage: Page,
  request: APIRequestContext,
  tag: string,
  visibility: Visibility,
) {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${tag}`;
  const a = `hist-alice-${runId}`;
  const b = `hist-bob-${runId}`;
  await registerUser(request, a, `${a}-pass`);
  await registerUser(request, b, `${b}-pass`);
  const alice = await passwordLogin(request, hs, a, `${a}-pass`);
  const bob = await passwordLogin(request, hs, b, `${b}-pass`);
  const roomName = `History ${runId}`;
  const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${alice.accessToken}` },
    data: {
      name: roomName,
      preset: 'private_chat',
      initial_state: [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
        {
          type: 'm.room.history_visibility',
          state_key: '',
          content: { history_visibility: visibility },
        },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  // Bob's device must exist when Alice invites him, to receive the shared keys.
  await login(bobPage, {
    available: true,
    hs,
    user: b,
    pass: `${b}-pass`,
  } as HomeserverSession);
  await login(page, {
    available: true,
    hs,
    user: a,
    pass: `${a}-pass`,
  } as HomeserverSession);
  return { runId, roomName, bob, alicePass: `${a}-pass`, bobPass: `${b}-pass` };
}

async function openInvite(page: Page): Promise<void> {
  await page.getByTestId('room-actions-overflow').click();
  await page.getByTestId('overflow-invite-people').click();
}

/** Invite Bob from the open dialog, accept as Bob, and open the room for him. */
async function inviteAndJoin(
  page: Page,
  bobPage: Page,
  bobId: string,
  roomName: string,
): Promise<void> {
  await page.getByLabel('@user:server or a name').fill(bobId);
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(page.getByText(`Invitation sent to ${bobId}.`)).toBeVisible({
    timeout: 30_000,
  });
  const accept = bobPage.getByRole('button', {
    name: `Accept invite to ${roomName}`,
  });
  await expect(accept).toBeVisible({ timeout: 60_000 });
  await accept.click();
  await openNamedRoom(bobPage, roomName);
}

test.describe('Earlier messages for invited members', () => {
  test.skip(!session.available, 'needs a Synapse homeserver');

  test('an invitee reads earlier messages once the inviter has set up encryption', async ({
    page,
    request,
    secondaryApp,
  }) => {
    // Two signed-in pages, two encryption setups and a key bundle round trip.
    test.setTimeout(240_000);
    const bobPage = await secondaryApp.launch();
    // At invite the SDK downloads the room's backed-up keys to share; #1722 failed on that body.
    // It logs the failure at debug level, so also count the backup manager's other debug lines:
    // with none, an empty failure list would prove nothing.
    const backupFailures: string[] = [];
    let backupDebugLines = 0;
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('[RustBackupManager]')) backupDebugLines += 1;
      if (text.includes('Failed to decrypt megolm session from backup'))
        backupFailures.push(text);
    });
    const { runId, roomName, bob, alicePass, bobPass } = await setUp(
      page,
      bobPage,
      request,
      'hs',
      'shared',
    );

    await openNamedRoom(page, roomName);
    await openInvite(page);
    const note = page.getByTestId('user-picker-note');
    await expect(note).toContainText(
      'Verify this device before inviting, so they can read earlier messages.',
    );
    await expect(
      note.getByRole('button', { name: 'Verify this device' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await setUpEncryption(bobPage, bobPass);
    await setUpEncryption(page, alicePass);
    await openNamedRoom(page, roomName);
    const earlier = [`before one ${runId}`, `before two ${runId}`];
    for (const body of earlier) {
      await sendComposerLines(page, [body]);
      await expect(rowOf(page, body)).toBeVisible({ timeout: 30_000 });
    }

    await openInvite(page);
    await expect(note).toHaveText(
      "If they've set up encryption, they'll be able to read earlier messages.",
    );
    await inviteAndJoin(page, bobPage, bob.userId, roomName);

    for (const body of earlier) {
      await expect(rowOf(bobPage, body)).toBeVisible({ timeout: 60_000 });
    }
    expect(backupDebugLines).toBeGreaterThan(0);
    expect(backupFailures).toEqual([]);
  });

  test('an invitee to a room shown only to members sees nothing from before', async ({
    page,
    request,
    secondaryApp,
  }) => {
    test.setTimeout(180_000);
    const bobPage = await secondaryApp.launch();
    const { runId, roomName, bob } = await setUp(
      page,
      bobPage,
      request,
      'hj',
      'joined',
    );

    await openNamedRoom(page, roomName);
    const before = `before ${runId}`;
    await sendComposerLines(page, [before]);
    await expect(rowOf(page, before)).toBeVisible({ timeout: 30_000 });

    await openInvite(page);
    await expect(page.getByTestId('user-picker-note')).toHaveText(
      "They'll be able to read messages sent after they join.",
    );
    await inviteAndJoin(page, bobPage, bob.userId, roomName);

    const after = `after ${runId}`;
    await sendComposerLines(page, [after]);
    await expect(rowOf(bobPage, after)).toBeVisible({ timeout: 60_000 });
    await expect(rowOf(bobPage, before)).toHaveCount(0);
  });
});
