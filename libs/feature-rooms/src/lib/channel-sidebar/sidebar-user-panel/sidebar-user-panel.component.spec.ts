import { render } from '@trinity/testing';
import { SidebarUserPanelComponent } from './sidebar-user-panel.component';

// The account-switcher dropdown (switch / add / sign out / re-auth rows) is
// exercised end-to-end through the parent in channel-sidebar.component.spec.ts;
// here we cover the always-visible footer trigger this component owns.
const USER = { userId: '@alice:hs', displayName: 'Alice', avatarMxc: null };

describe('SidebarUserPanelComponent', () => {
  it('shows the signed-in user name and handle in the trigger', async () => {
    const { container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    expect(container.querySelector('.userbar__name')?.textContent).toContain(
      'Alice',
    );
    expect(container.querySelector('.userbar__handle')?.textContent).toContain(
      '@alice:hs',
    );
  });

  it('emits openSettings when the settings button is clicked', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    let opened = false;
    fixture.componentInstance.openSettings.subscribe(() => (opened = true));
    container.querySelector<HTMLElement>('.userbar__settings')!.click();

    expect(opened).toBe(true);
  });

  const ACCOUNTS = [
    { userId: '@alice:hs', displayName: 'Alice', avatarMxc: null, unread: 0 },
    { userId: '@bob:hs', displayName: 'Bob', avatarMxc: null, unread: 0 },
    { userId: '@carol:hs', displayName: 'Carol', avatarMxc: null, unread: 0 },
  ];

  it('shows the plain avatar and no stack while only one account is shown', async () => {
    const { container } = await render(SidebarUserPanelComponent, {
      inputs: {
        user: USER,
        accounts: ACCOUNTS,
        activeUserId: '@alice:hs',
        shownAccountIds: new Set(['@alice:hs']),
      },
    });

    expect(container.querySelector('[data-testid="account-stack"]')).toBeNull();
    expect(container.querySelector('.userbar__handle')?.textContent).toContain(
      '@alice:hs',
    );
  });

  it('stacks the mixed accounts, active first, with a count of the rest', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: {
        user: USER,
        accounts: ACCOUNTS,
        activeUserId: '@bob:hs',
        shownAccountIds: new Set(['@alice:hs', '@bob:hs']),
      },
    });

    const stack = container.querySelector('[data-testid="account-stack"]');
    expect(stack).toBeTruthy();
    expect(stack!.querySelectorAll('trn-avatar').length).toBe(2);
    // The active account leads the stack so it stays the front tile.
    expect(
      fixture.componentInstance.mixedAccounts().map((a) => a.userId),
    ).toEqual(['@bob:hs', '@alice:hs']);
    expect(
      container.querySelector('[data-testid="account-stack-count"]')
        ?.textContent,
    ).toContain('2 accounts');
  });

  it('offers the picker only when more than one account is signed in', async () => {
    const { fixture } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER, accounts: [ACCOUNTS[0]] },
    });
    expect(fixture.componentInstance.canPickAccounts()).toBe(false);

    fixture.componentRef.setInput('accounts', ACCOUNTS);
    expect(fixture.componentInstance.canPickAccounts()).toBe(true);
  });

  // The menu lives in a CDK overlay, so assert off `document` after opening it.
  it('ticks the shown accounts and locks the active one', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: {
        user: USER,
        accounts: ACCOUNTS,
        activeUserId: '@alice:hs',
        shownAccountIds: new Set(['@alice:hs', '@bob:hs']),
      },
    });
    container.querySelector<HTMLElement>('.userbar__trigger')!.click();
    fixture.detectChanges();
    document
      .querySelector<HTMLElement>('[data-testid="show-accounts"]')!
      .click();
    fixture.detectChanges();

    const row = (userId: string) =>
      document.querySelector<HTMLElement>(
        `[data-testid="show-account-${userId}"]`,
      )!;
    expect(row('@alice:hs').getAttribute('aria-checked')).toBe('true');
    expect(row('@bob:hs').getAttribute('aria-checked')).toBe('true');
    expect(row('@carol:hs').getAttribute('aria-checked')).toBe('false');
    // The active account can't be unticked — disabled, so CDK never fires it.
    expect(row('@alice:hs').getAttribute('data-disabled')).toBe('');
    expect(row('@bob:hs').getAttribute('data-disabled')).toBeNull();

    const toggled: string[] = [];
    fixture.componentInstance.toggleAccountShown.subscribe((id) =>
      toggled.push(id),
    );
    row('@carol:hs').click();
    expect(toggled).toEqual(['@carol:hs']);
  });
});
