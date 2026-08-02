import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnDialogService } from '@trinity/helm/overlay';
import { AccountPickerService } from './account-picker.service';
import { AccountPickerComponent } from './account-picker.component';
import { type AccountSummary } from '../channel-sidebar/sidebar-user-panel/sidebar-user-panel.component';

const ACCOUNTS: AccountSummary[] = [
  { userId: '@alice:hs', displayName: 'Alice', avatarMxc: null, unread: 0 },
];

describe('AccountPickerService', () => {
  let openAndWait: ReturnType<typeof vi.fn>;
  let resolveDialog: (value: null) => void;

  beforeEach(() => {
    openAndWait = vi.fn(
      () => new Promise<null>((resolve) => (resolveDialog = resolve)),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [MockProvider(TrnDialogService, { openAndWait })],
    });
  });

  const svc = () => TestBed.inject(AccountPickerService);

  it('presents the picker with the accounts it was given', async () => {
    const opened = svc().open({
      accounts: ACCOUNTS,
      activeUserId: '@alice:hs',
    });
    await Promise.resolve(); // the deliberate focus-ordering yield
    await Promise.resolve();

    expect(openAndWait).toHaveBeenCalledWith(AccountPickerComponent, {
      ariaLabel: 'Show accounts',
      inputs: { accounts: ACCOUNTS, activeUserId: '@alice:hs' },
      autoFocus: '[data-autofocus]',
    });

    resolveDialog(null);
    await opened;
  });

  // A repeat trigger while it is already up must be a no-op, not a second stacked dialog —
  // the same guard ReactionsDialogService and MessageSearchService carry.
  it('ignores a repeat trigger while it is already showing', async () => {
    const first = svc().open({ accounts: ACCOUNTS, activeUserId: null });
    await Promise.resolve();
    await Promise.resolve();

    await svc().open({ accounts: ACCOUNTS, activeUserId: null });

    expect(openAndWait).toHaveBeenCalledTimes(1);

    resolveDialog(null);
    await first;
  });

  it('can be reopened once dismissed', async () => {
    const first = svc().open({ accounts: ACCOUNTS, activeUserId: null });
    await Promise.resolve();
    await Promise.resolve();
    resolveDialog(null);
    await first;

    const second = svc().open({ accounts: ACCOUNTS, activeUserId: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(openAndWait).toHaveBeenCalledTimes(2);

    resolveDialog(null);
    await second;
  });
});
