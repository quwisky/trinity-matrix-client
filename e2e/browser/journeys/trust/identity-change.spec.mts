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
import { publishIdentityWithoutRecovery } from '../../../support/cross-signing.mts';
import {
  openNamedRoom,
  sendComposerLines,
} from '../../../support/message-composer.mts';

// Covers the room banner for members whose cryptographic identity changed (#1271) and
// acknowledging it. Each member's identity is published over the API and later replaced, so
// Alice's client first records one identity and then sees a new one: an identity change she
// hadn't verified, which needs acknowledging. A previously verified identity that changes
// needs a live emoji verification between two clients first; its Withdraw and Verify again
// actions are covered by unit tests. Invited members count too, but the homeserver only
// reports key changes for people who share a joined room, so an invitee's change is not seen
// before they join; the several-people case uses joined members.
// Needs a Synapse homeserver; self-skips otherwise.
const session = homeserverSession();

interface Person {
  readonly user: string;
  readonly pass: string;
  readonly userId: string;
}

async function person(
  request: APIRequestContext,
  hs: string,
  user: string,
): Promise<Person> {
  const pass = `${user}-pass`;
  await registerUser(request, user, pass);
  const { userId } = await passwordLogin(request, hs, user, pass);
  await publishIdentityWithoutRecovery(request, hs, user, pass);
  return { user, pass, userId };
}

/**
 * Alice, signed in to Trinity, in an encrypted room with `members`.
 * Her first message makes her client fetch and record everyone's identity.
 */
async function setUp(
  page: Page,
  request: APIRequestContext,
  tag: string,
  names: readonly string[],
) {
  const hs = session.hs as string;
  const runId = `${testResourceId('run')}${tag}`;
  const alice = `idc-alice-${runId}`;
  await registerUser(request, alice, `${alice}-pass`);
  const aliceLogin = await passwordLogin(request, hs, alice, `${alice}-pass`);
  const joined = await Promise.all(
    names.map((n) => person(request, hs, `idc-${n}-${runId}`)),
  );
  const roomName = `Identity ${runId}`;
  const created = await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${aliceLogin.accessToken}` },
    data: {
      name: roomName,
      preset: 'private_chat',
      invite: joined.map((p) => p.userId),
      initial_state: [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
      ],
    },
  });
  expect(created.ok()).toBe(true);
  const roomId = (await created.json()).room_id as string;
  for (const p of joined) {
    const { accessToken } = await passwordLogin(request, hs, p.user, p.pass);
    const join = await request.post(
      `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(join.ok()).toBe(true);
  }

  await login(page, {
    available: true,
    hs,
    user: alice,
    pass: `${alice}-pass`,
  } as HomeserverSession);
  await openNamedRoom(page, roomName);
  await sendComposerLines(page, [`hello ${runId}`]);
  // Encrypting needs everyone's keys, so once the message reaches the server Alice's client
  // has recorded each member's current identity: a later change is then a change.
  const messages = `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`;
  await expect
    .poll(
      async () => {
        const res = await request.get(messages, {
          headers: { Authorization: `Bearer ${aliceLogin.accessToken}` },
        });
        const chunk =
          ((await res.json()) as { chunk?: { type: string; sender: string }[] })
            .chunk ?? [];
        return chunk.some(
          (e) =>
            e.type === 'm.room.encrypted' && e.sender === aliceLogin.userId,
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return { hs, joined };
}

const replaceIdentity = (request: APIRequestContext, hs: string, p: Person) =>
  publishIdentityWithoutRecovery(request, hs, p.user, p.pass);

test.describe('Changed identities in a room', () => {
  test.skip(!session.available, 'needs a Synapse homeserver');

  test("a member's changed identity is announced and can be acknowledged", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const { hs, joined } = await setUp(page, request, 'ic1', ['bob']);
    const [bob] = joined as [Person];

    await replaceIdentity(request, hs, bob);

    const banner = page.getByTestId('identity-change-banner');
    await expect(banner).toContainText(/identity changed\./, {
      timeout: 60_000,
    });
    await expect(banner).toContainText(bob.user);
    await banner.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
  });

  test('several changed identities are reviewed together', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const { hs, joined } = await setUp(page, request, 'ic2', ['bob', 'carol']);
    const [bob, carol] = joined as [Person, Person];

    await replaceIdentity(request, hs, bob);
    await replaceIdentity(request, hs, carol);

    const banner = page.getByTestId('identity-change-banner');
    await expect(banner).toContainText(
      '2 people in this room changed identity.',
      { timeout: 60_000 },
    );
    await banner.getByRole('button', { name: 'Review' }).click();
    const list = page.getByTestId('identity-review-list');
    for (const p of [bob, carol]) {
      await list
        .getByTestId(`identity-review-${p.userId}`)
        .getByRole('button', { name: 'Acknowledge' })
        .click();
      await expect(list.getByTestId(`identity-review-${p.userId}`)).toHaveCount(
        0,
        { timeout: 30_000 },
      );
    }
    await expect(list).toHaveCount(0);
    await expect(banner).toHaveCount(0);
  });
});
