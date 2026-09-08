import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { TrnDialogService } from '@trinity/components/overlay';
import { AccountPickerService } from './account-picker.service';
import { AccountPickerComponent } from './account-picker.component';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';
import { Subject } from 'rxjs';

const ACCOUNTS: AccountSummary[] = [
  { userId: '@alice:hs', displayName: 'Alice', avatarMxc: null, unread: 0 },
];

describe('AccountPickerService', () => {
  let openAndWait$: Mock;
  let dialogClosed: Subject<void>;

  beforeEach(() => {
    dialogClosed = new Subject<void>();
    openAndWait$ = vi.fn(() => dialogClosed);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [MockProvider(TrnDialogService, { openAndWait$ })],
    });
  });

  const svc = () => TestBed.inject(AccountPickerService);

  it('presents the picker with the accounts it was given', async () => {
    svc().open({
      accounts: ACCOUNTS,
      activeUserId: '@alice:hs',
    });
    await Promise.resolve(); // the deliberate focus-ordering yield
    await Promise.resolve();

    expect(openAndWait$).toHaveBeenCalledWith(AccountPickerComponent, {
      ariaLabel: 'Accounts in view',
      inputs: { accounts: ACCOUNTS, activeUserId: '@alice:hs' },
      autoFocus: '[data-autofocus]',
    });

    dialogClosed.complete();
  });

  // A repeat trigger while it is already up must be a no-op, not a second stacked dialog —
  // the same guard ReactionsDialogService carries.
  it('ignores a repeat trigger while it is already showing', async () => {
    svc().open({ accounts: ACCOUNTS, activeUserId: null });
    await Promise.resolve();
    await Promise.resolve();

    svc().open({ accounts: ACCOUNTS, activeUserId: null });

    expect(openAndWait$).toHaveBeenCalledTimes(1);

    dialogClosed.complete();
  });

  it('can be reopened once dismissed', async () => {
    svc().open({ accounts: ACCOUNTS, activeUserId: null });
    await Promise.resolve();
    await Promise.resolve();
    dialogClosed.complete();

    dialogClosed = new Subject<void>();
    openAndWait$.mockReturnValue(dialogClosed);
    svc().open({ accounts: ACCOUNTS, activeUserId: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(openAndWait$).toHaveBeenCalledTimes(2);

    dialogClosed.complete();
  });
});
