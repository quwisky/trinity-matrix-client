import { signal } from '@angular/core';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DialogRef } from '@trinity/kit/overlay';
import { AccountScopeService } from '@trinity/data-access/rooms';
import { AccountPickerComponent } from './account-picker.component';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';

const ACCOUNTS: AccountSummary[] = [
  { userId: '@alice:hs', displayName: 'Alice', avatarMxc: null, unread: 0 },
  { userId: '@bob:hs', displayName: 'Bob', avatarMxc: null, unread: 0 },
  { userId: '@carol:hs', displayName: 'Carol', avatarMxc: null, unread: 0 },
];

describe('AccountPickerComponent', () => {
  let selected: ReturnType<typeof signal<ReadonlySet<string>>>;
  let toggle: Mock;
  let close: Mock;

  beforeEach(() => {
    selected = signal<ReadonlySet<string>>(new Set(['@alice:hs', '@bob:hs']));
    toggle = vi.fn();
    close = vi.fn();
  });

  function renderPicker(activeUserId: string | null = '@alice:hs') {
    return render(AccountPickerComponent, {
      inputs: { accounts: ACCOUNTS, activeUserId },
      providers: [
        MockProvider(AccountScopeService, { selected, toggle }),
        { provide: DialogRef, useValue: { close } },
      ],
    });
  }

  const row = (container: Element, userId: string) =>
    container.querySelector<HTMLButtonElement>(
      `[data-testid="show-account-${userId}"]`,
    )!;

  // These two attributes are the contract multi-account.spec.mts asserts against the SUBMENU,
  // where trnDropdownMenuCheckbox supplies them for free. The dialog has to reproduce them or
  // the mobile path silently diverges from the desktop one.
  it('marks each row checked or unchecked, and locks the active account', async () => {
    const { container } = await renderPicker();

    expect(row(container, '@alice:hs').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(row(container, '@bob:hs').getAttribute('aria-checked')).toBe('true');
    expect(row(container, '@carol:hs').getAttribute('aria-checked')).toBe(
      'false',
    );

    expect(row(container, '@alice:hs').getAttribute('data-disabled')).toBe('');
    expect(row(container, '@bob:hs').getAttribute('data-disabled')).toBeNull();
  });

  it('toggles an account without closing — this is a multi-select', async () => {
    const { container } = await renderPicker();

    row(container, '@carol:hs').click();
    row(container, '@bob:hs').click();

    expect(toggle.mock.calls.map(([id]) => id)).toEqual([
      '@carol:hs',
      '@bob:hs',
    ]);
    expect(close).not.toHaveBeenCalled();
  });

  // The service refuses to drop the active account, so a row that looked tickable but did
  // nothing would drift out of sync with the state behind it.
  it('never toggles the active account', async () => {
    const { container } = await renderPicker();

    row(container, '@alice:hs').click();

    expect(toggle).not.toHaveBeenCalled();
    expect(row(container, '@alice:hs').disabled).toBe(true);
  });

  it('re-renders a row when the selection changes underneath it', async () => {
    const { container, fixture } = await renderPicker();
    expect(row(container, '@carol:hs').getAttribute('aria-checked')).toBe(
      'false',
    );

    selected.set(new Set(['@alice:hs', '@bob:hs', '@carol:hs']));
    fixture.detectChanges();

    expect(row(container, '@carol:hs').getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('closes from the Done button', async () => {
    const { container } = await renderPicker();

    container
      .querySelector<HTMLElement>('[data-testid=account-picker-done]')!
      .click();

    expect(close).toHaveBeenCalled();
  });

  // TrnDialogService focuses `[data-autofocus]`; without it CDK lands on the Done button.
  it('marks the first account for autofocus', async () => {
    const { container } = await renderPicker();

    expect(
      container.querySelector('[data-autofocus]')?.getAttribute('data-testid'),
    ).toBe('show-account-@alice:hs');
  });
});
