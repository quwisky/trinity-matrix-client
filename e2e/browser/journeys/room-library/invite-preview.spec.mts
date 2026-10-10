import { expect, test, testResourceId } from '../../../fixtures.mts';
import { homeserverSession, login } from '../../../support/app.mts';
import { passwordLogin, registerUser } from '../../../support/account.mts';

// Clicking an invite row previews the room; Accept there joins, then Open shows the room.
const session = homeserverSession();

test('previews an invite from its row and accepts it there', async ({
  page,
  request,
}) => {
  test.skip(!session.available, 'needs the homeserver');
  const hs = session.hs as string;
  const run = testResourceId('invprev');
  const owner = `invprev-owner-${run}`;
  const guest = `invprev-guest-${run}`;
  const roomName = `Preview ${run.slice(-8)}`;
  await registerUser(request, owner, `${owner}-pass`);
  await registerUser(request, guest, `${guest}-pass`);
  const ownerSession = await passwordLogin(request, hs, owner, `${owner}-pass`);
  const guestSession = await passwordLogin(request, hs, guest, `${guest}-pass`);
  await request.post(`${hs}/_matrix/client/v3/createRoom`, {
    headers: { Authorization: `Bearer ${ownerSession.accessToken}` },
    data: {
      name: roomName,
      topic: 'Monthly reads',
      preset: 'private_chat',
      invite: [guestSession.userId],
    },
  });

  await login(page, {
    available: true,
    hs,
    user: guest,
    pass: `${guest}-pass`,
  });
  const open = page.getByRole('button', {
    name: `Preview invite to ${roomName}`,
  });
  await expect(open).toBeVisible({ timeout: 30_000 });
  await open.click();

  const preview = page.getByTestId('room-link-preview');
  await expect(preview.getByTestId('room-link-name')).toHaveText(roomName);
  await expect(preview.getByTestId('room-link-topic')).toHaveText(
    'Monthly reads',
  );
  const primary = preview.getByTestId('room-link-primary');
  await expect(primary).toHaveText('Accept invitation');
  await primary.click();
  // The preview confirms the join first, then offers to open the room.
  await expect(primary).toHaveText('Open room');
  await primary.click();

  await expect(preview).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId('composer-input')).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole('button', { name: `Accept invite to ${roomName}` }),
  ).toHaveCount(0);
});
