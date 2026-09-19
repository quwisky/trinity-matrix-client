import assert from 'node:assert/strict';
import type {
  AccountWorkspaceCase,
  AccountWorkspaceCaseContext,
} from './account-workspace-client.mts';
import { installAccountBadgeRecorder } from './account-badge-recorder.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

type Account = Awaited<ReturnType<AccountWorkspaceCaseContext['fixtures']['account']>>;

const source = (line: string): string =>
  `e2e/browser/journeys/accounts/account-lifecycle.spec.mts:${line}`;

async function switchTo(context: AccountWorkspaceCaseContext, account: Account): Promise<void> {
  await context.client.openMenu();
  await context.client.tap('[data-testid="account-row"]', {
    text: `@${account.username}:`,
  });
  await context.client.rooms(account);
}

async function expectMenuActions(context: AccountWorkspaceCaseContext, count: number): Promise<void> {
  const menu = await context.client.visible('.account-menu[role="menu"]');
  assert.match(menu.text, /Switch account/);
  await context.client.expectCount('[data-testid="show-accounts"]', 1, { text: 'Accounts in view' });
  await context.client.expectCount('[data-testid="add-account"]', 1, { text: 'Add account' });
  await context.client.expectCount('[data-testid="logout"]', 1, { text: 'Remove account from this device' });
  await context.client.expectCount('[data-testid="account-row"]', count);
}

const addAndOpen = async (
  context: AccountWorkspaceCaseContext,
  account: Account,
): Promise<void> => {
  await context.client.addAccount(account);
  await context.client.rooms(account);
};

async function addsSecondAccount(context: AccountWorkspaceCaseContext): Promise<void> {
  const first = await context.fixtures.account('lifecycle-add-primary');
  const second = await context.fixtures.account('lifecycle-add-secondary');
  await context.client.login(first);
  await addAndOpen(context, second);
  await context.client.visible('trn-banner', { text: 'Set up encryption' });
  await context.client.openMenu();
  await expectMenuActions(context, 2);
  await context.client.key('escape');
  await context.client.focused('[data-testid="user-menu-trigger"]');
  await switchTo(context, first);
}

async function repeatedSwitches(context: AccountWorkspaceCaseContext): Promise<void> {
  const first = await context.fixtures.account('lifecycle-switch-primary');
  const second = await context.fixtures.account('lifecycle-switch-secondary');
  const third = await context.fixtures.account('lifecycle-switch-tertiary');
  await context.client.login(first);
  await addAndOpen(context, second);
  await addAndOpen(context, third);
  await switchTo(context, second);
  await switchTo(context, second);
  assert(!(await context.client.surface()).body.includes('Unable to switch accounts right now.'));
  await switchTo(context, third);
  await switchTo(context, first);
  assert(!(await context.client.surface()).body.includes('Unable to switch accounts right now.'));
}

async function badgeAcrossAccounts(context: AccountWorkspaceCaseContext): Promise<void> {
  const primary = await context.fixtures.account('lifecycle-badge-primary');
  const sender = await context.fixtures.account('lifecycle-badge-sender');
  const reader = await context.fixtures.account('lifecycle-badge-reader');
  const room = await context.fixtures.createRoom(reader, {
    name: 'Lifecycle badge room',
    invite: [sender.userId],
  });
  await context.fixtures.join(sender, room.id);
  await context.fixtures.sendMessage(sender, room.id, 'badge message one', 'badge-message-1');
  await context.fixtures.sendMessage(sender, room.id, 'badge message two', 'badge-message-2');
  const recorder = await installAccountBadgeRecorder(context.client);
  let failure: unknown;
  try {
    await context.client.reload();
    await context.client.login(primary);
    await addAndOpen(context, reader);
    await waitForNativeShellState(
      () => recorder.count(),
      (count) => count === 2,
      'badge count for two unread messages on active reader account',
      context.signal,
      30_000,
    );
    await context.client.record('badge-reader-active', { count: await recorder.count(), calls: await recorder.calls() });
    await switchTo(context, primary);
    await waitForNativeShellState(
      () => recorder.count(),
      (count) => count === 2,
      'badge count remains two after switching to zero-unread primary account',
      context.signal,
      30_000,
    );
    await context.client.record('badge-primary-active', { count: await recorder.count(), calls: await recorder.calls() });
  } catch (error) {
    failure = error;
  } finally {
    try {
      await recorder.close();
    } catch (error) {
      if (failure !== undefined) throw new AggregateError([failure, error], 'Badge assertion and recorder cleanup failed');
      throw error;
    }
  }
  if (failure !== undefined) throw failure;
}

async function removesActiveAccount(context: AccountWorkspaceCaseContext): Promise<void> {
  const first = await context.fixtures.account('lifecycle-remove-primary');
  const second = await context.fixtures.account('lifecycle-remove-secondary');
  await context.client.login(first);
  await addAndOpen(context, second);
  await context.client.openMenu();
  await context.client.tap('[data-testid="logout"]');
  await context.client.tap('[data-testid="alert-confirm"]');
  await context.client.activeAccountRooms(first);
  await context.client.openMenu();
  await context.client.expectCount('[data-testid="account-row"]', 1);
}

async function readdsRemovedAccount(context: AccountWorkspaceCaseContext): Promise<void> {
  const first = await context.fixtures.account('lifecycle-readd-primary');
  const second = await context.fixtures.account('lifecycle-readd-secondary');
  await context.client.login(first);
  await addAndOpen(context, second);
  await context.client.openMenu();
  await context.client.tap('[data-testid="logout"]');
  await context.client.tap('[data-testid="alert-confirm"]');
  await context.client.activeAccountRooms(first);
  await addAndOpen(context, second);
  await context.client.openMenu();
  await context.client.expectCount('[data-testid="account-row"]', 2);
}

async function removesAndReauthenticatesOnlyAccount(context: AccountWorkspaceCaseContext): Promise<void> {
  const account = await context.fixtures.account('lifecycle-remove-only');
  await context.client.login(account);
  await context.client.openMenu();
  await context.client.tap('[data-testid="logout"]');
  await context.client.tap('[data-testid="alert-confirm"]');
  await waitForNativeShellState(() => context.client.surface(), surface => surface.url.endsWith('/login'), 'last-account removal returns to login', context.signal, 30_000);
  await context.client.visible('#homeserver');
  await context.client.login(account);
}

async function cancelsAdd(context: AccountWorkspaceCaseContext): Promise<void> {
  const account = await context.fixtures.account('lifecycle-cancel');
  await context.client.login(account);
  await context.client.openMenu();
  await context.client.tap('[data-testid="add-account"]');
  await context.client.visible('[data-testid="cancel-add"]');
  await context.client.tap('[data-testid="cancel-add"]');
  await context.client.activeAccountRooms(account);
  await context.client.openMenu();
  await context.client.expectCount('[data-testid="account-row"]', 1);
}

async function reauthenticatesPrefilledAccount(context: AccountWorkspaceCaseContext): Promise<void> {
  const account = await context.fixtures.account('lifecycle-reauth');
  await context.client.login(account);
  const handle = await context.client.visible('.userbar__handle');
  const userId = handle.text.trim();
  await context.client.navigate(`/login?reauth=${encodeURIComponent(userId)}`);
  await context.client.visible('body', { text: 'Sign in again to reconnect this account' });
  await context.client.waitElements('#username', elements => elements.length === 1 && elements[0]!.visible && elements[0]!.value === userId && elements[0]!.disabled, 'reauthentication username is prefilled and locked');
  await context.client.fill('#password', account.password);
  await context.client.tap('button', { exactText: 'Sign in' });
  await context.client.activeAccountRooms(account);
}

export const accountLifecycleCases: readonly AccountWorkspaceCase[] = [
  { id: 'adds-second-account', source: source('25-83'), run: addsSecondAccount },
  { id: 'repeated-account-switches', source: source('85-130'), run: repeatedSwitches },
  { id: 'badge-sums-unread-across-accounts', source: source('132-191'), run: badgeAcrossAccounts },
  { id: 'removes-one-account', source: source('193-220'), run: removesActiveAccount },
  { id: 'readds-removed-account', source: source('222-260'), run: readdsRemovedAccount },
  { id: 'removes-only-account-and-reconnects', source: source('262-283'), run: removesAndReauthenticatesOnlyAccount },
  { id: 'cancels-account-add', source: source('285-300'), run: cancelsAdd },
  { id: 'reauthenticates-prefilled-account', source: source('302-330'), run: reauthenticatesPrefilledAccount },
];
