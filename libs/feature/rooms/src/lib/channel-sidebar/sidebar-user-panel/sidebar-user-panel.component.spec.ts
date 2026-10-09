import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { TitleBarState } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { By } from '@angular/platform-browser';
import { TrnTooltip } from '@trinity/components/generic-content';
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

  it('keeps System status beside Settings and emits its open action', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    let opened = false;
    fixture.componentInstance.openSystemStatus.subscribe(() => (opened = true));
    const status = container.querySelector<HTMLElement>(
      '[data-testid="open-system-status"]',
    );
    expect(status?.getAttribute('aria-label')).toBe('System status');
    status!.click();

    expect(opened).toBe(true);
  });

  it('marks the System status entry when capability problems exist', async () => {
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

  const ACCOUNTS = [
    { userId: '@alice:hs', displayName: 'Alice', avatarMxc: null, unread: 0 },
    { userId: '@bob:hs', displayName: 'Bob', avatarMxc: null, unread: 0 },
    { userId: '@carol:hs', displayName: 'Carol', avatarMxc: null, unread: 0 },
  ];

  it('renders readable initials in account and signed-out rows', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: {
        user: USER,
        accounts: ACCOUNTS,
        activeUserId: '@alice:hs',
        reauthAccounts: ['@dave:hs'],
      },
    });

    container.querySelector<HTMLElement>('.userbar__trigger')!.click();
    fixture.detectChanges();

    const accountRow = document.querySelector<HTMLElement>(
      '[data-testid="account-row"]',
    );
    const reauthRow = document.querySelector<HTMLElement>(
      '[data-testid="reauth-row"]',
    );
    expect(accountRow?.querySelector('trn-avatar')?.textContent).toContain('A');
    expect(reauthRow?.querySelector('trn-avatar')?.textContent).toContain('D');
  });

  it('shows ? for an account whose display name is only a sigil', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: {
        user: USER,
        accounts: [{ ...ACCOUNTS[0], displayName: '@' }, ACCOUNTS[1]],
        activeUserId: '@alice:hs',
      },
    });

    container.querySelector<HTMLElement>('.userbar__trigger')!.click();
    fixture.detectChanges();

    const accountRow = document.querySelector<HTMLElement>(
      '[data-testid="account-row"]',
    );
    expect(accountRow?.querySelector('trn-avatar')?.textContent).toContain('?');
  });

  it('shows name and handle and no accounts chip with a single account', async () => {
    const { container } = await render(SidebarUserPanelComponent, {
      inputs: {
        user: USER,
        accounts: [ACCOUNTS[0]],
        activeUserId: '@alice:hs',
      },
    });

    expect(
      container.querySelector('[data-testid="account-stack-count"]'),
    ).toBeNull();
    expect(container.querySelector('.userbar__name')?.textContent).toContain(
      'Alice',
    );
    expect(container.querySelector('.userbar__handle')?.textContent).toContain(
      '@alice:hs',
    );
  });

  it.each([
    [3, '+2'],
    [5, '+4'],
  ])(
    'reads the other accounts on the chip with %i signed in',
    async (count, text) => {
      const accounts = Array.from({ length: count }, (_, i) => ({
        userId: `@u${i}:hs`,
        displayName: `U${i}`,
        avatarMxc: null,
        unread: 0,
      }));
      const { fixture, container } = await render(SidebarUserPanelComponent, {
        inputs: { user: USER, accounts, activeUserId: '@u0:hs' },
      });

      const chip = container.querySelector<HTMLElement>(
        '[data-testid="account-stack-count"]',
      )!;
      expect(chip.textContent?.trim()).toBe(text);
      expect(chip.getAttribute('aria-label')).toBe(
        `${count - 1} more accounts`,
      );
      chip.click();
      fixture.detectChanges();
      expect(
        document.querySelectorAll('[data-testid="account-row"]'),
      ).toHaveLength(count);
    },
  );

  it('draws no presence dot until presence is known, and uses the button recipe', async () => {
    const { fixture, container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    expect(container.querySelector('trn-avatar .presence-dot')).toBeNull();
    // The dropdown trigger overwrites data-slot, so assert the recipe directive itself.
    expect(
      fixture.debugElement
        .queryAll(By.directive(TrnButton))
        .map((element) => element.nativeElement),
    ).toContain(container.querySelector('[data-testid="user-menu-trigger"]'));
  });

  it.each(['online', 'unavailable', 'offline'] as const)(
    'draws the %s presence of the signed-in user on the avatar',
    async (presence) => {
      const { container } = await render(SidebarUserPanelComponent, {
        inputs: { user: USER, presence },
      });

      expect(
        container
          .querySelector('trn-avatar .presence-dot')
          ?.getAttribute('data-presence'),
      ).toBe(presence);
    },
  );

  it('names a single other account in the singular', async () => {
    const { container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER, accounts: ACCOUNTS.slice(0, 2) },
    });

    expect(
      container
        .querySelector('[data-testid="account-stack-count"]')
        ?.getAttribute('aria-label'),
    ).toBe('1 more account');
  });

  it('keeps settings and system status without the title row', async () => {
    const { container } = await render(SidebarUserPanelComponent, {
      inputs: { user: USER },
    });

    expect(
      container.querySelector('[data-testid="open-system-status"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="open-settings"]'),
    ).not.toBeNull();
  });

  it.each([
    { titleRow: false, problems: false, shown: true },
    { titleRow: false, problems: true, shown: true },
    { titleRow: true, problems: false, shown: true },
    { titleRow: true, problems: true, shown: false },
  ])(
    'System status shown=$shown with title row $titleRow and problems $problems',
    async ({ titleRow, problems, shown }) => {
      const { container } = await render(SidebarUserPanelComponent, {
        inputs: { user: USER, hasSystemStatusProblems: problems },
      });
      TestBed.inject(TitleBarState).setActive(titleRow);
      TestBed.tick();

      expect(
        container.querySelector('[data-testid="open-system-status"]') !== null,
      ).toBe(shown);
      expect(
        container.querySelector('[data-testid="open-settings"]'),
      ).not.toBeNull();
    },
  );

  it.each([
    ['online', 'Alice, online'],
    ['unavailable', 'Alice, away'],
    ['offline', 'Alice, offline'],
    [null, 'Alice'],
  ] as const)(
    'names the user menu trigger with presence %s',
    async (presence, name) => {
      const { container } = await render(SidebarUserPanelComponent, {
        inputs: { user: USER, presence },
      });

      expect(
        container
          .querySelector('[data-testid="user-menu-trigger"]')
          ?.getAttribute('aria-label'),
      ).toBe(name);
    },
  );

  describe('stylesheet', () => {
    const scss = readFileSync(
      join(__dirname, 'sidebar-user-panel.component.scss'),
      'utf8',
    );

    it('floats the raised card from md and ellipsises the name', () => {
      expect(scss).toMatch(/@media #\{\$md\} \{[^}]*position: absolute/);
      for (const token of [
        'var(--trinity-surface-floating-card)',
        'var(--trinity-shape-overlay-radius)',
        'var(--trinity-shadow-floating)',
      ]) {
        expect(scss).toContain(token);
      }
      expect(scss).toMatch(/\.userbar__name,[^{]*\{\s*@include ellipsis/);
    });
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
