import assert from 'node:assert/strict';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';
import {
  type AccountWorkspaceCase,
  type AccountWorkspaceCaseContext,
  PIXEL_5_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';

const trigger = '[data-testid="user-menu-trigger"]';
const accountsMenu = '[data-testid="show-accounts"]';

function accountRow(userId: string): string {
  return `[data-testid^=${JSON.stringify(`show-account-${userId}`)}]`;
}

async function mixInAccount(
  { client }: AccountWorkspaceCaseContext,
  userId: string,
): Promise<void> {
  await client.openMenu();
  await client.tap(accountsMenu);
  await client.tap(accountRow(userId), { text: userId });
  await client.key('escape');
  await client.key('escape');
  await client.focused(trigger);
}

async function desktopAccountPicker(
  { client }: AccountWorkspaceCaseContext,
  userId: string,
  initialFocus = true,
): Promise<{ readonly selector: string; readonly row: string }> {
  if (initialFocus) await client.focusFixture(trigger);
  else await client.focused(trigger);
  await client.key('arrowDown');
  await client.visible('.account-menu[role="menu"]');
  await client.key('escape');
  await client.focused(trigger);
  await client.key('arrowDown');
  await client.focusFixture(accountsMenu);
  await client.key('arrowRight');
  const selector = '.account-pick-menu[role="menu"]';
  await client.visible(selector);
  const row = accountRow(userId);
  await client.visible(row, { text: userId });
  return { selector, row };
}

async function assertVisibleBadge(
  { client }: AccountWorkspaceCaseContext,
  selector: string,
  text?: string,
): Promise<void> {
  await waitForNativeShellState(() => evaluateNative(client.webview, `(() => {
    const matches = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(element =>
      ${text === undefined ? 'true' : `(element.textContent ?? '').includes(${JSON.stringify(text)})`}
    );
    if (matches.length !== 1) return false;
    const badge = matches[0].querySelector('[data-testid="account-badge"]');
    if (!(badge instanceof HTMLElement)) return false;
    const rect = badge.getBoundingClientRect();
    const style = getComputedStyle(badge);
    return rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none';
  })()`), value => value === true, 'visible account badge descendant', client.signal);
}

async function expectActiveAccount(
  { client }: AccountWorkspaceCaseContext,
  account: Awaited<ReturnType<AccountWorkspaceCaseContext['fixtures']['account']>>,
  timeoutMs = 15_000,
): Promise<void> {
  await client.visible('.userbar__handle', { text: account.userId }, timeoutMs);
}

async function createTwoAccounts(
  { fixtures }: AccountWorkspaceCaseContext,
  roles: readonly [string, string],
  suffix = false,
) {
  const [a, b] = await Promise.all([
    fixtures.account(roles[0], suffix ? { longName: true } : {}),
    fixtures.account(roles[1], suffix ? { longName: true } : {}),
  ]);
  return { a, b };
}

async function setThemeAndFont(
  { client }: AccountWorkspaceCaseContext,
  dark: boolean,
  fontSize = '125%',
): Promise<void> {
  await evaluateNative(
    client.webview,
    `(() => { document.documentElement.classList.toggle('dark', ${dark}); document.documentElement.style.fontSize = ${JSON.stringify(fontSize)}; return true; })()`,
  );
}

export async function assertDesktopAccountPickerGeometry(
  client: AccountWorkspaceCaseContext['client'],
  selector: string,
): Promise<void> {
  await waitForNativeShellState(() => evaluateNative(client.webview, `(() => {
    const menu = document.querySelector(${JSON.stringify(selector)});
    if (!(menu instanceof HTMLElement)) return false;
    const rows = [...menu.querySelectorAll('.account-pick')];
    const indicators = rows.map(row => row.querySelector('.account-pick__indicator')?.getBoundingClientRect());
    const bounds = menu.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight &&
      indicators.length > 0 && indicators.every(indicator => indicator && Math.abs(indicator.x - indicators[0].x) < 1) &&
      rows.every((row, index) => {
        const identity = row.querySelector('.account-pick__id')?.getBoundingClientRect();
        return identity !== undefined && identity.width > 60 && identity.right <= indicators[index].left;
      });
  })()`), value => value === true, 'desktop account picker geometry', client.signal);
}

export async function assertAccountRowVisualAlignment(
  client: AccountWorkspaceCaseContext['client'],
  row: string,
): Promise<void> {
  const value = await evaluateNative(client.webview, `(() => {
    const row = document.querySelector(${JSON.stringify(row)});
    const avatar = row?.querySelector('trn-avatar')?.getBoundingClientRect();
    const check = row?.querySelector('.account-pick__indicator')?.getBoundingClientRect();
    return Boolean(avatar && check && Math.abs(avatar.y + avatar.height / 2 - (check.y + check.height / 2)) < 12);
  })()`);
  assert.equal(value, true, 'account avatar and check alignment');
}

const mixedRooms: AccountWorkspaceCase = {
  id: 'mixed-rooms-badged-switch',
  source: 'e2e/browser/journeys/accounts/mixed-account-workspace.spec.mts:16-71',
  async run(context) {
    const { client, fixtures } = context;
    const { a, b } = await createTwoAccounts(context, ['mixed-a', 'mixed-b']);
    const roomA = await fixtures.createRoom(a, { name: 'Room A mixed' });
    const roomB = await fixtures.createRoom(b, { name: 'Room B mixed' });
    await client.login(a);
    await client.addAccount(b);
    await expectActiveAccount(context, b, 20_000);
    await client.visible('.channel', { text: roomB.name }, 20_000);
    await client.expectCount('.channel', 0, { text: roomA.name });
    await mixInAccount(context, a.userId);
    await client.visible('.channel', { text: roomA.name }, 20_000);
    await client.visible('.channel', { text: roomB.name }, 20_000);
    await assertVisibleBadge(context, '.channel', roomA.name);
    await client.tap('.channel', { text: roomA.name });
    await expectActiveAccount(context, a, 20_000);
    await client.visible('trn-channel-sidebar .channel.active', { text: roomA.name }, 15_000);
  },
};

const mixedSpaces: AccountWorkspaceCase = {
  id: 'mixed-spaces-badged-switch',
  source: 'e2e/browser/journeys/accounts/mixed-account-workspace.spec.mts:73-128',
  async run(context) {
    const { client, fixtures } = context;
    const { a, b } = await createTwoAccounts(context, ['msp-a', 'msp-b']);
    const spaceA = await fixtures.createRoom(a, { name: 'Space A mixed', creation_content: { type: 'm.space' } });
    const spaceB = await fixtures.createRoom(b, { name: 'Space B mixed', creation_content: { type: 'm.space' } });
    await client.login(a);
    await client.addAccount(b);
    await expectActiveAccount(context, b, 20_000);
    const railPill = (name: string) => `trn-server-rail button[aria-label^=${JSON.stringify(name)}]`;
    await client.visible(railPill(spaceB.name), {}, 20_000);
    await client.expectCount(railPill(spaceA.name), 0);
    await mixInAccount(context, a.userId);
    await client.visible(railPill(spaceA.name), {}, 20_000);
    await assertVisibleBadge(context, railPill(spaceA.name));
    await client.tap(railPill(spaceA.name));
    await expectActiveAccount(context, a, 20_000);
  },
};

const persistedPicker: AccountWorkspaceCase = {
  id: 'mixed-picker-persistence-and-keyboard',
  source: 'e2e/browser/journeys/accounts/mixed-account-workspace.spec.mts:132-322',
  async run(context) {
    const { client, fixtures } = context;
    const { a, b } = await createTwoAccounts(context, ['pick-a', 'pick-b'], true);
    const roomA = await fixtures.createRoom(a, { name: 'Room A pick' });
    const roomB = await fixtures.createRoom(b, { name: 'Room B pick' });
    await client.login(a);
    await client.addAccount(b);
    await expectActiveAccount(context, b, 20_000);
    await client.visible('.channel', { text: roomB.name }, 20_000);
    await mixInAccount(context, a.userId);
    await client.visible('.channel', { text: roomA.name }, 20_000);
    await client.visible('[data-testid="account-stack"]');
    await client.visible('[data-testid="account-stack-count"]', { text: '2 accounts' });
    await client.reload();
    await client.visible('.channel', { text: roomA.name }, 30_000);
    await client.visible('.channel', { text: roomB.name }, 20_000);
    const originalTheme = await evaluateNative(client.webview, `(() => ({
      dark: document.documentElement.classList.contains('dark'),
      fontSize: document.documentElement.style.fontSize,
    }))()`);

    const picker = await desktopAccountPicker(context, b.userId);
    await client.visible(`${picker.selector} [data-slot="dropdown-menu-label"]`, { exactText: 'Accounts in view' });
    const active = await client.visible(picker.row, { text: b.userId });
    assert.equal(active.attributes['aria-checked'], 'true');
    assert.equal(active.attributes['data-disabled'], '');
    assert.equal(active.style.opacity, '1');
    await client.visible(`${picker.row} trn-avatar`);
    assert(active.text.includes('Always included'));
    await setThemeAndFont(context, false);
    for (const dark of [false, true]) {
      await client.key('escape');
      await client.key('escape');
      await setThemeAndFont(context, dark);
      const opened = await desktopAccountPicker(context, b.userId, false);
      await client.visible(`${opened.selector} [data-slot="dropdown-menu-label"]`, { exactText: 'Accounts in view' });
      await assertDesktopAccountPickerGeometry(client, opened.selector);
      await assertAccountRowVisualAlignment(client, opened.row);
      await client.capture(`accounts-in-view-desktop-${dark ? 'dark' : 'light'}-125`);
    }
    await client.key('escape');
    await client.key('escape');
    await evaluateNative(
      client.webview,
      `(() => {
        const original = ${JSON.stringify(originalTheme)};
        document.documentElement.classList.toggle('dark', original.dark);
        document.documentElement.style.fontSize = original.fontSize;
        return true;
      })()`,
    );
    await client.focused(trigger);
    const opened = await desktopAccountPicker(context, b.userId, false);
    const rowElements = await client.elements(opened.row);
    const rowName = await client.elements(`${opened.row} .account-pick__name`);
    const rowHandle = await client.elements(`${opened.row} .account-pick__handle`);
    assert.equal(rowElements.length, 1);
    assert.equal(rowName.length, 1);
    assert.equal(rowHandle.length, 1);
    assert(rowName[0]!.rect.x >= rowElements[0]!.rect.x);
    assert(rowHandle[0]!.rect.x >= rowElements[0]!.rect.x);

    const other = await client.visible(accountRow(a.userId), { text: a.userId });
    assert.equal(other.attributes['aria-checked'], 'true');
    const selectorRows = '.account-pick-menu[role="menu"] [role="menuitemcheckbox"]';
    await client.key('end');
    await client.waitElements(selectorRows, rows => rows.length > 0 && rows.at(-1)!.focused, 'last picker row focused after End');
    await client.key('home');
    const first = await client.waitElements(selectorRows, rows => rows.length > 0 && rows[0]!.focused, 'first picker row focused after Home');
    if (first.length && !first[0]!.attributes['data-testid']?.includes(a.userId)) await client.key('arrowDown');
    await client.focused(accountRow(a.userId), { text: a.userId });
    await client.key('space');
    await expectActiveAccount(context, b);
    await client.waitElements(accountRow(a.userId), rows => rows.length === 1 && rows[0]!.attributes['aria-checked'] === 'false', 'picker selection is unchecked after Space', { text: a.userId });
    await client.key('escape');
    await client.focused(accountsMenu);
    await client.key('escape');
    await client.focused(trigger);
    await client.expectCount('.channel', 0, { text: roomA.name });
    await client.visible('.channel', { text: roomB.name });
    await client.expectCount('[data-testid="account-stack"]', 0);
  },
};

const narrowPicker: AccountWorkspaceCase = {
  id: 'narrow-account-picker-dialog',
  source: 'e2e/browser/journeys/accounts/mixed-account-workspace.spec.mts:339-478',
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run(context) {
    const { client, fixtures } = context;
    const { a, b } = await createTwoAccounts(context, ['narrow-a', 'narrow-b'], true);
    const roomA = await fixtures.createRoom(a, { name: 'Narrow A' });
    await client.login(a);
    await client.addAccount(b);
    await expectActiveAccount(context, b);
    await client.resize(390, 844);
    await waitForNativeShellState(() => evaluateNative(client.webview, 'navigator.userAgent'), value => typeof value === 'string' && value.includes('Android'), 'Android user agent', context.signal);
    await setThemeAndFont(context, false);
    await client.tap(trigger);
    await client.tap(accountsMenu);
    const picker = await client.visible('[data-testid="account-picker"]');
    assert.equal(picker.style.display, 'flex');
    await client.visible('[data-testid="account-picker"]', { text: 'Accounts in view' });
    await client.focused('[data-testid="account-picker"] [data-autofocus]');
    assert.equal((await client.elements('.picker__list'))[0]!.style.overflowY, 'auto');
    await client.visible('[data-testid="account-picker-done"]');
    await client.visible(trigger);
    const active = await client.visible(accountRow(b.userId), { text: b.userId });
    assert.equal(active.attributes['aria-checked'], 'true');
    assert.equal(active.attributes['data-disabled'], '');
    assert.equal(active.style.opacity, '1');
    assert(active.text.includes('Always included'));
    await client.visible(`${accountRow(b.userId)} trn-avatar`);
    await assertAccountRowVisualAlignment(client, accountRow(b.userId));
    for (const dark of [false, true]) {
      await setThemeAndFont(context, dark);
      await client.capture(`accounts-in-view-mobile-${dark ? 'dark' : 'light'}-125`);
    }
    await client.resize(390, 260);
    await client.capture('accounts-in-view-mobile-scroll');
    await client.waitElements('.picker__list', rows => rows.length === 1 && rows[0]!.scrollHeight > rows[0]!.clientHeight, 'short picker list overflow');
    await client.scrollIntoViewIfNeeded(accountRow(a.userId), '.picker__list');
    const other = await client.visible(accountRow(a.userId), { text: a.userId });
    assert.equal(other.unobstructedCenter, true);
    await client.tap(accountRow(a.userId), { text: a.userId });
    await client.waitElements(accountRow(a.userId), rows => rows.length === 1 && rows[0]!.attributes['aria-checked'] === 'true', 'native picker selection is checked');
    await client.visible('[data-testid="account-picker"]');
    await expectActiveAccount(context, b);
    const done = await client.visible('[data-testid="account-picker-done"]');
    assert(done.rect.x >= 0 && done.rect.y >= 0 && done.rect.right <= 390 && done.rect.bottom <= 260);
    assert.equal(done.unobstructedCenter, true);
    await client.tap('[data-testid="account-picker-done"]');
    await client.expectCount('[data-testid="account-picker"]', 0);
    await client.focused(trigger);
    await client.resize(390, 844);
    await client.tap(trigger);
    await client.tap(accountsMenu);
    const reopened = await client.visible(accountRow(a.userId), { text: a.userId });
    assert.equal(reopened.attributes['aria-checked'], 'true');
    await client.key('escape');
    await client.focused(trigger);
    await client.visible('.channel', { text: roomA.name }, 20_000);
  },
};

const quickSwitcher: AccountWorkspaceCase = {
  id: 'mixed-quick-switcher',
  source: 'e2e/browser/journeys/accounts/mixed-account-workspace.spec.mts:481-529',
  async run(context) {
    const { client, fixtures } = context;
    const { a, b } = await createTwoAccounts(context, ['qs-a', 'qs-b']);
    const roomA = await fixtures.createRoom(a, { name: 'Zephyr quick-switch' });
    await client.login(a);
    await client.addAccount(b);
    await expectActiveAccount(context, b);
    await client.expectCount('.channel', 0, { text: roomA.name });
    await client.tap('[data-testid="open-switcher"]');
    await client.fill('[data-testid="switcher-input"]', 'Zephyr');
    await client.expectCount('[data-testid="switcher-result"]', 0);
    await client.key('escape');
    await mixInAccount(context, a.userId);
    await client.tap('[data-testid="open-switcher"]');
    await client.fill('[data-testid="switcher-input"]', 'Zephyr');
    const hit = await client.visible('[data-testid="switcher-result"]', { text: roomA.name });
    await assertVisibleBadge(context, '[data-testid="switcher-result"]', roomA.name);
    await client.tap('[data-testid="switcher-result"]', { text: roomA.name });
    await expectActiveAccount(context, a, 20_000);
    await client.visible('trn-channel-sidebar .channel.active', { text: roomA.name }, 15_000);
    void hit;
  },
};

const mixedInvite: AccountWorkspaceCase = {
  id: 'mixed-invite-acting-identity',
  source: 'e2e/browser/journeys/accounts/mixed-account-workspace.spec.mts:534-636',
  async run(context) {
    const { client, fixtures } = context;
    const { a, b } = await createTwoAccounts(context, ['inv-a', 'inv-b']);
    const host = await fixtures.account('inv-host');
    await fixtures.setDisplayName(a, 'Alpha invite');
    await fixtures.setDisplayName(b, 'Bravo invite');
    const roomA = await fixtures.createRoom(a, { name: 'Room A invite' });
    await fixtures.createRoom(b, { name: 'Room B invite' });
    const invited = await fixtures.createRoom(host, { name: 'Invited room' });
    await fixtures.invite(host, invited.id, a);
    await client.login(a);
    await client.visible('.userbar__name', { exactText: 'Alpha invite' }, 20_000);
    await client.addAccount(b);
    await expectActiveAccount(context, b);
    await client.visible('.userbar__name', { exactText: 'Bravo invite' }, 20_000);
    await client.expectCount('.invite', 0, { text: invited.name });
    await mixInAccount(context, a.userId);
    await client.visible('.invite', { text: invited.name }, 20_000);
    await assertVisibleBadge(context, '.invite', invited.name);
    await client.tap('.channel', { text: roomA.name });
    await expectActiveAccount(context, a, 20_000);
    await client.visible('[data-testid="active-account-chip"]');
    await client.visible('[data-testid="active-account-chip"] .title-account__name', { exactText: 'Alpha invite' }, 20_000);
    await client.expectCount('[data-testid="active-account-chip"]', 0, { text: `@${a.username}:` });
  },
};

export const mixedAccountWorkspaceCases: readonly AccountWorkspaceCase[] = [
  mixedRooms,
  mixedSpaces,
  persistedPicker,
  narrowPicker,
  quickSwitcher,
  mixedInvite,
];
