import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountRuntimeService,
  type AccountSwitchOutcome,
} from '@trinity/data-access/accounts';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { AccountSwitchLauncherAdapter } from './account-switch-launcher.adapter';

function setup(
  accountIds: readonly string[],
  switched: () => ReturnType<
    AccountRuntimeService['switchActiveAccount']
  > = () => of<AccountSwitchOutcome>({ kind: 'ready', accountId: '@b:hs' }),
) {
  const ids = signal(accountIds);
  const active = signal<string | null>('@a:hs');
  const switchActiveAccount = vi.fn(switched);
  TestBed.configureTestingModule({
    providers: [
      AccountSwitchLauncherAdapter,
      MockProvider(AccountRuntimeService, {
        activeAccountId: active.asReadonly(),
        switchActiveAccount,
      }),
      MockProvider(SessionStateService, { accountIds: ids.asReadonly() }),
    ],
  });
  return {
    launcher: TestBed.inject(AccountSwitchLauncherAdapter),
    ids,
    active,
    switchActiveAccount,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('AccountSwitchLauncherAdapter', () => {
  it('switches to the first other signed-in account, in the switcher’s order', async () => {
    const test = setup(['@c:hs', '@a:hs', '@b:hs']);

    expect(test.launcher.hasOtherAccount()).toBe(true);
    await expect(firstValueFrom(test.launcher.switchToOther())).resolves.toBe(
      true,
    );
    expect(test.switchActiveAccount).toHaveBeenCalledWith('@c:hs');
  });

  it('reports false when no other account is signed in', async () => {
    const test = setup(['@a:hs']);

    expect(test.launcher.hasOtherAccount()).toBe(false);
    await expect(firstValueFrom(test.launcher.switchToOther())).resolves.toBe(
      false,
    );
    expect(test.switchActiveAccount).not.toHaveBeenCalled();
  });

  it('follows the signed-in accounts as they change', () => {
    const test = setup(['@a:hs']);
    expect(test.launcher.hasOtherAccount()).toBe(false);

    test.ids.set(['@a:hs', '@b:hs']);
    expect(test.launcher.hasOtherAccount()).toBe(true);
  });

  it.each([
    [
      'fails',
      () =>
        of<AccountSwitchOutcome>({
          kind: 'failed',
          accountId: '@b:hs',
          failure: 'account-unavailable',
        }),
    ],
    [
      'cannot run now',
      () =>
        of<AccountSwitchOutcome>({
          kind: 'transition-in-progress',
          accountId: '@b:hs',
          operation: 'signing-out-account',
        }),
    ],
    ['errors', () => throwError(() => new Error('broken'))],
  ] as const)('reports false when the switch %s', async (_case, switched) => {
    const test = setup(['@a:hs', '@b:hs'], switched);

    await expect(firstValueFrom(test.launcher.switchToOther())).resolves.toBe(
      false,
    );
  });
});
