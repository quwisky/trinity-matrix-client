import { By } from '@angular/platform-browser';
import { TrnTooltip } from '@trinity/components/generic-content';
import { render } from '@trinity/testing';
import { SidebarUserPanelComponent } from './sidebar-user-panel.component';

// The account-switcher dropdown (switch / add / sign out / re-auth rows) is
// exercised end-to-end through the parent in channel-sidebar.component.spec.ts;
// here we cover the always-visible footer trigger this component owns.
const USER = { userId: '@alice:hs', displayName: 'Alice', avatarMxc: null };

/**
 * An ArrowDown keydown CDK will actually act on.
 *
 * `CdkMenuTrigger` switches on the deprecated `event.keyCode`, which jsdom leaves at 0 for a
 * `KeyboardEvent` built from `key` alone — so the plain constructor produces an event the
 * trigger ignores, and a test using it would pass against the very bug it is written for.
 */
function arrowDown(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
  });
  Object.defineProperty(event, 'keyCode', { get: () => 40 });
  return event;
}

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

  it('keeps System Status beside Settings and emits its open action', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    let opened = false;
    fixture.componentInstance.openSystemStatus.subscribe(() => (opened = true));
    const status = container.querySelector<HTMLElement>(
      '[data-testid="open-system-status"]',
    );
    expect(status?.getAttribute('aria-label')).toBe('System Status');
    status!.click();

    expect(opened).toBe(true);
  });

  it('marks the System Status entry when capability problems exist', async () => {
    const { container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER, hasSystemStatusProblems: true },
    });

    expect(
      container.querySelector('[data-testid="open-system-status"]'),
    ).toHaveClass('userbar__system-status--problem');
  });

  it('uses the themeable tooltip contract instead of a native title', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });
    const button = container.querySelector<HTMLElement>(
      '[data-testid="open-settings"]',
    );

    expect(button?.hasAttribute('title')).toBe(false);
    expect(
      fixture.debugElement
        .queryAll(By.directive(TrnTooltip))
        .map((element) => element.nativeElement),
    ).toContain(button);
  });

  it('asks the host to look up the homeserver versions when the menu is opened', async () => {
    // Lazy on purpose: the version is only ever visible in this menu and in Settings →
    // Server, so nothing is spent until someone reaches for one of them. The host's lookup
    // is cached, so reaching for it repeatedly costs nothing.
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    let asked = 0;
    fixture.componentInstance.accountsOpened.subscribe(() => (asked += 1));
    container
      .querySelector<HTMLElement>('[data-testid="user-menu-trigger"]')!
      .click();

    expect(asked).toBe(1);
  });

  it('asks when the menu is opened by keyboard, not only by pointer', async () => {
    // The bug this pins: CDK's trigger opens on ArrowDown by calling `open()` directly and
    // never dispatches a click, so a `(click)` handler left a keyboard user with no lookup
    // at all — silently, for the whole session. Enter and Space are safe, because CDK stands
    // aside there for the native click, which is what made this easy to miss.
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    let asked = 0;
    fixture.componentInstance.accountsOpened.subscribe(() => (asked += 1));
    container
      .querySelector<HTMLElement>('[data-testid="user-menu-trigger"]')!
      .dispatchEvent(arrowDown());

    expect(asked).toBe(1);
  });

  it('does not ask again when the menu is closed', async () => {
    // CDK's click handler is `toggle()`, so a `(click)` binding fired on the closing click
    // as well — a second lookup for a menu the user just dismissed.
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });
    const trigger = container.querySelector<HTMLElement>(
      '[data-testid="user-menu-trigger"]',
    )!;

    let asked = 0;
    fixture.componentInstance.accountsOpened.subscribe(() => (asked += 1));
    trigger.click(); // open
    trigger.click(); // close

    expect(asked).toBe(1);
  });

  it('prefetches on hover and on focus, so the menu opens with its answers ready', async () => {
    // The menu is a `side="top"` overlay pinned by its bottom edge, so a version arriving
    // after it opens pushes the rows upward under the pointer. Hovering or tabbing to the
    // trigger is enough warning to have the answer in hand first.
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });
    const trigger = container.querySelector<HTMLElement>(
      '[data-testid="user-menu-trigger"]',
    )!;

    let asked = 0;
    fixture.componentInstance.accountsOpened.subscribe(() => (asked += 1));
    trigger.dispatchEvent(new Event('pointerenter'));
    trigger.dispatchEvent(new Event('focus'));

    expect(asked).toBe(2);
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
    expect(document.querySelector('.account-pick-menu')?.textContent).toContain(
      'Accounts in view',
    );
    expect(row('@alice:hs').textContent).toContain('Always included');
    expect(row('@alice:hs').querySelector('trn-avatar')?.textContent).toContain(
      'A',
    );
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
    fixture.componentRef.setInput(
      'shownAccountIds',
      new Set(['@alice:hs', '@carol:hs']),
    );
    fixture.detectChanges();
    expect(row('@carol:hs').getAttribute('aria-checked')).toBe('true');
    expect(row('@bob:hs').getAttribute('aria-checked')).toBe('false');
  });

  // Issue #28. Below the md breakpoint this panel is a bar across the bottom of a full-screen
  // sidebar, so a submenu flying out beside the account menu has nowhere to go and lands back
  // on top of it. The host decides; this component only renders the affordance it is told to.
  describe('narrow layout', () => {
    async function openMenu(pickAccountsInDialog: boolean) {
      const rendered = await render(SidebarUserPanelComponent, {
        inputs: {
          user: USER,
          accounts: ACCOUNTS,
          activeUserId: '@alice:hs',
          shownAccountIds: new Set(['@alice:hs']),
          pickAccountsInDialog,
        },
      });
      rendered.container
        .querySelector<HTMLElement>('.userbar__trigger')!
        .click();
      rendered.fixture.detectChanges();
      return rendered;
    }

    it('raises a request for the dialog instead of opening a submenu', async () => {
      const { fixture } = await openMenu(true);
      const asked: number[] = [];
      fixture.componentInstance.openAccountPicker.subscribe(() =>
        asked.push(1),
      );

      document
        .querySelector<HTMLElement>('[data-testid="show-accounts"]')!
        .click();
      fixture.detectChanges();

      expect(asked).toHaveLength(1);
      // Nothing flew out — that is the whole point on this layout.
      expect(
        document.querySelector('[data-testid="show-account-@bob:hs"]'),
      ).toBeNull();
    });

    it('still opens the submenu on the wide layout', async () => {
      const { fixture } = await openMenu(false);
      const asked: number[] = [];
      fixture.componentInstance.openAccountPicker.subscribe(() =>
        asked.push(1),
      );

      document
        .querySelector<HTMLElement>('[data-testid="show-accounts"]')!
        .click();
      fixture.detectChanges();

      expect(asked).toHaveLength(0);
      expect(
        document.querySelector('[data-testid="show-account-@bob:hs"]'),
      ).not.toBeNull();
    });
  });
});
